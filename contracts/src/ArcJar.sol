// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @dev Callback into the factory so its owner -> jars registry follows ownership changes.
interface IArcJarRegistry {
    function recordOwnerChange(address previousOwner, address newOwner) external;
}

/// @title ArcJar — non-custodial income jars for USDC on Arc
/// @author ArcJars
/// @notice Every USDC payment that lands here is split into the owner's own jars
///         (e.g. Spendable / Tax / Profit). Jars can be time-locked so tax money
///         stays untouched until the date you choose. Locks can only be extended.
/// @dev    Arc-specific design notes:
///         * USDC is Arc's native coin (18 decimals). The ERC-20 interface at
///           0x3600..0000 (6 decimals) is a *view of the same balance*: on Arc
///           `USDC.balanceOf(a) == a.balance / 1e12`. This contract therefore keeps
///           every amount in native 18-decimal units and derives "unallocated"
///           funds from `address(this).balance`, which covers both native sends
///           and ERC-20 `transfer`s into the jar with a single code path.
///         * Native sends run `receive()`, which splits on the spot when the
///           sender forwarded enough gas. ERC-20 transfers (and Memo-tagged
///           payments, which go through the ERC-20 interface) do not execute
///           recipient code; anyone can call `sweep()` to split them later.
///         * Payouts are native value transfers. Arc reverts value transfers to
///           address(0) and to blocklisted accounts; both surface as `TransferFailed`.
///         Deployed as EIP-1167 clones by {ArcJarFactory}; `feeRecipient` and
///         `feeBps` are immutables of the implementation, shared by every clone.
contract ArcJar is ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------ constants

    /// @notice Hard ceiling on the protocol fee: 0.2 %. Cannot be raised, ever.
    uint16 public constant MAX_FEE_BPS = 20;
    /// @notice Fee per split is capped at 1 USDC (native 18-decimal units).
    uint256 public constant FEE_CAP = 1e18;
    uint16 internal constant BPS = 10_000;
    /// @notice Maximum number of jars, including the Spendable jar (index 0).
    uint256 public constant MAX_JARS = 8;
    /// @notice Locks can be set at most this far in the future (fat-finger guard).
    uint64 public constant MAX_LOCK = 3650 days;
    /// @notice Arc's ERC-20 interface onto the native USDC balance. Never rescuable.
    address public constant USDC_ERC20 = 0x3600000000000000000000000000000000000000;

    // ----------------------------------------------------------------- immutables

    address public immutable feeRecipient;
    uint16 public immutable feeBps;

    // ---------------------------------------------------------------------- types

    struct Jar {
        uint128 balance; // native USDC, 18 decimals
        uint16 bps; // share of each payment (jar 0 gets the remainder)
        uint64 unlockAt; // 0 = never locked; otherwise withdrawals blocked until then
    }

    struct JarConfig {
        bytes32 name;
        uint16 bps;
        uint64 unlockAt;
        address dest;
    }

    // ---------------------------------------------------------------------- state

    address public owner;
    /// @notice Proposed new owner; must call {acceptOwnership} (two-step transfer).
    address public pendingOwner;
    /// @notice The factory that created this jar (receives ownership-change callbacks).
    address public factory;
    /// @notice Sum of all jar balances plus accrued fees. Anything above this is unallocated.
    uint256 public allocated;
    /// @notice Protocol fees accrued and not yet sent to `feeRecipient`.
    uint256 public feesAccrued;

    Jar[] internal _jars;
    bytes32[] internal _names;
    address[] internal _dests;

    // --------------------------------------------------------------------- events

    event Initialized(address indexed owner);
    event Split(address indexed from, uint256 amount, uint256 fee, bool viaSweep);
    event JarAdded(uint256 indexed jarId, bytes32 name, uint16 bps, uint64 unlockAt, address dest);
    event SplitsUpdated(uint16[] bps);
    event LockExtended(uint256 indexed jarId, uint64 unlockAt);
    event DestUpdated(uint256 indexed jarId, address dest);
    event Withdrawn(uint256 indexed jarId, address indexed to, uint256 amount);
    event FeesCollected(address indexed to, uint256 amount);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event TokenRescued(address indexed token, address indexed to, uint256 amount);

    // --------------------------------------------------------------------- errors

    error AlreadyInitialized();
    error NotOwner();
    error ZeroAddress();
    error FeeTooHigh();
    error TooManyJars();
    error BpsOverflow();
    error LengthMismatch();
    error LockTooFar();
    error LockShortened();
    error Locked(uint64 unlockAt);
    error BadJar();
    error InsufficientJarBalance();
    error NothingToSweep();
    error TransferFailed();
    error NotPendingOwner();
    error ProtectedToken();
    error NativeBalanceMoved();
    error BadDest();

    // ------------------------------------------------------------------ modifiers

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    // ---------------------------------------------------------------- constructor

    /// @param feeRecipient_ where protocol fees go (immutable)
    /// @param feeBps_ protocol fee in basis points, at most {MAX_FEE_BPS}
    constructor(address feeRecipient_, uint16 feeBps_) {
        if (feeRecipient_ == address(0)) revert ZeroAddress();
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        feeRecipient = feeRecipient_;
        feeBps = feeBps_;
        owner = address(0xdead); // lock the implementation itself
    }

    /// @notice One-time setup, called by the factory right after cloning.
    /// @param owner_ jar owner
    /// @param configs extra jars (Tax, Profit, ...). Jar 0 "Spendable" is created
    ///        automatically and receives whatever the other jars don't.
    function initialize(address owner_, JarConfig[] calldata configs) external {
        if (owner != address(0)) revert AlreadyInitialized();
        if (owner_ == address(0)) revert ZeroAddress();
        owner = owner_;
        factory = msg.sender;
        _jars.push(Jar({balance: 0, bps: 0, unlockAt: 0}));
        _names.push("Spendable");
        _dests.push(address(0));
        for (uint256 i; i < configs.length; ++i) {
            _addJar(configs[i]);
        }
        emit Initialized(owner_);
    }

    // ----------------------------------------------------------------- incoming

    /// @notice Native USDC payments are split on arrival.
    /// @dev Deliberately has no "low gas, split later" branch: `eth_estimateGas` returns
    ///      the cheapest gas limit that succeeds, so such a branch would make every
    ///      wallet estimate (and pay for) the deferred path. A sender that forwards too
    ///      little gas simply reverts and keeps its funds; senders that cannot set gas
    ///      (fixed 21000-gas exchange withdrawals) should pay through the USDC ERC-20
    ///      interface instead, which `sweep()` then splits. Only this payment is split;
    ///      earlier unswept funds are left for `sweep()`.
    receive() external payable {
        _split(msg.value, msg.sender, false);
    }

    /// @notice Split everything that arrived without being split: ERC-20 transfers,
    ///         Memo-tagged payments, low-gas native sends. Callable by anyone.
    function sweep() external nonReentrant returns (uint256 amount) {
        amount = unallocated();
        if (amount == 0) revert NothingToSweep();
        _split(amount, msg.sender, true);
    }

    // ------------------------------------------------------------------- owner

    /// @notice Withdraw from a jar. Respects the jar's time lock.
    /// @param amount native 18-decimal amount; `type(uint256).max` withdraws the whole jar
    /// @param to recipient, ignored when the jar has a fixed destination
    function withdraw(uint256 jarId, uint256 amount, address to) external onlyOwner nonReentrant {
        if (jarId >= _jars.length) revert BadJar();
        Jar storage j = _jars[jarId];
        if (block.timestamp < j.unlockAt) revert Locked(j.unlockAt);
        address dest = _dests[jarId];
        address recipient = dest != address(0) ? dest : to;
        if (recipient == address(0) || recipient == address(this)) revert ZeroAddress();
        if (amount == type(uint256).max) amount = j.balance;
        if (amount == 0 || amount > j.balance) revert InsufficientJarBalance();
        unchecked {
            j.balance -= uint128(amount);
            allocated -= amount;
        }
        emit Withdrawn(jarId, recipient, amount);
        _send(recipient, amount);
    }

    function addJar(JarConfig calldata config) external onlyOwner {
        _addJar(config);
    }

    /// @notice Change the split for future income. `bps[i]` applies to jar `i + 1`.
    function setSplits(uint16[] calldata bps) external onlyOwner {
        uint256 n = _jars.length;
        if (bps.length != n - 1) revert LengthMismatch();
        uint256 total;
        for (uint256 i; i < bps.length; ++i) {
            total += bps[i];
            _jars[i + 1].bps = bps[i];
        }
        if (total > BPS) revert BpsOverflow();
        emit SplitsUpdated(bps);
    }

    /// @notice Push a jar's unlock date further out. Locks can never be shortened.
    function extendLock(uint256 jarId, uint64 unlockAt) external onlyOwner {
        if (jarId >= _jars.length) revert BadJar();
        Jar storage j = _jars[jarId];
        if (unlockAt <= j.unlockAt) revert LockShortened();
        if (unlockAt > block.timestamp + MAX_LOCK) revert LockTooFar();
        j.unlockAt = unlockAt;
        emit LockExtended(jarId, unlockAt);
    }

    /// @notice Set (or clear with address(0)) a fixed payout address for a jar.
    function setDest(uint256 jarId, address dest) external onlyOwner {
        if (jarId >= _jars.length) revert BadJar();
        if (dest == address(this)) revert BadDest();
        _dests[jarId] = dest;
        emit DestUpdated(jarId, dest);
    }

    /// @notice Step 1 of 2: propose a new owner. Pass address(0) to cancel a pending transfer.
    ///         Nothing changes until `newOwner` calls {acceptOwnership}, so a typo can't
    ///         hand a (possibly time-locked) jar to an address nobody controls.
    function transferOwnership(address newOwner) external onlyOwner {
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    /// @notice Step 2 of 2: the proposed owner takes over. Locks and balances are unchanged.
    function acceptOwnership() external {
        address newOwner = pendingOwner;
        if (msg.sender != newOwner) revert NotPendingOwner();
        address previous = owner;
        owner = newOwner;
        pendingOwner = address(0);
        emit OwnershipTransferred(previous, newOwner);
        IArcJarRegistry(factory).recordOwnerChange(previous, newOwner);
    }

    /// @notice Return a token that is *not* USDC (EURC, cirBTC, WETH, ...) sent here by mistake.
    ///         Those tokens are never split and would otherwise be stuck forever.
    /// @dev    USDC can never leave through this path: the ERC-20 interface is rejected by
    ///         address, and as a chain-agnostic backstop the call reverts if the jar's native
    ///         balance went down, so any token that is a view of the native balance cannot be
    ///         used to bypass jar accounting or time locks.
    function rescueToken(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        if (token == USDC_ERC20 || token == address(0)) revert ProtectedToken();
        if (token.code.length == 0) revert ProtectedToken();
        if (to == address(0) || to == address(this)) revert ZeroAddress();
        uint256 nativeBefore = address(this).balance;
        IERC20(token).safeTransfer(to, amount);
        if (address(this).balance < nativeBefore) revert NativeBalanceMoved();
        emit TokenRescued(token, to, amount);
    }

    // ----------------------------------------------------------------- protocol

    /// @notice Send accrued protocol fees to `feeRecipient`. Callable by anyone.
    function collectFees() external nonReentrant returns (uint256 amount) {
        amount = feesAccrued;
        if (amount == 0) return 0;
        feesAccrued = 0;
        allocated -= amount;
        emit FeesCollected(feeRecipient, amount);
        _send(feeRecipient, amount);
    }

    // -------------------------------------------------------------------- views

    /// @notice Funds held by the jar that have not been split yet.
    function unallocated() public view returns (uint256) {
        return address(this).balance - allocated;
    }

    function jarCount() external view returns (uint256) {
        return _jars.length;
    }

    function jar(uint256 jarId)
        external
        view
        returns (bytes32 name, uint256 balance, uint16 bps, uint64 unlockAt, address dest)
    {
        if (jarId >= _jars.length) revert BadJar();
        Jar memory j = _jars[jarId];
        return (_names[jarId], j.balance, jarId == 0 ? spendableBps() : j.bps, j.unlockAt, _dests[jarId]);
    }

    /// @notice Everything the app needs in one call.
    function jars()
        external
        view
        returns (
            bytes32[] memory names,
            uint256[] memory balances,
            uint16[] memory bps,
            uint64[] memory unlockAts,
            address[] memory dests
        )
    {
        uint256 n = _jars.length;
        names = _names;
        dests = _dests;
        balances = new uint256[](n);
        bps = new uint16[](n);
        unlockAts = new uint64[](n);
        for (uint256 i; i < n; ++i) {
            Jar memory j = _jars[i];
            balances[i] = j.balance;
            bps[i] = i == 0 ? spendableBps() : j.bps;
            unlockAts[i] = j.unlockAt;
        }
    }

    /// @notice Share of each payment that lands in the Spendable jar (before rounding dust).
    function spendableBps() public view returns (uint16) {
        uint256 total;
        for (uint256 i = 1; i < _jars.length; ++i) {
            total += _jars[i].bps;
        }
        return uint16(BPS - total);
    }

    /// @notice Protocol fee for a payment of `amount`.
    function feeFor(uint256 amount) public view returns (uint256 fee) {
        fee = amount * feeBps / BPS;
        if (fee > FEE_CAP) fee = FEE_CAP;
    }

    // ----------------------------------------------------------------- internal

    function _split(uint256 amount, address from, bool viaSweep) internal {
        uint256 fee = feeFor(amount);
        uint256 net = amount - fee;
        uint256 n = _jars.length;
        uint256 distributed;
        for (uint256 i = 1; i < n; ++i) {
            Jar storage j = _jars[i];
            uint256 part = net * j.bps / BPS;
            if (part != 0) {
                j.balance += uint128(part);
                distributed += part;
            }
        }
        // Rounding dust always goes to Spendable, so jars always sum to `net` exactly.
        _jars[0].balance += uint128(net - distributed);
        feesAccrued += fee;
        allocated += amount;
        emit Split(from, amount, fee, viaSweep);
    }

    function _addJar(JarConfig calldata c) internal {
        uint256 id = _jars.length;
        if (id >= MAX_JARS) revert TooManyJars();
        if (c.unlockAt > block.timestamp + MAX_LOCK) revert LockTooFar();
        uint256 total = c.bps;
        for (uint256 i = 1; i < id; ++i) {
            total += _jars[i].bps;
        }
        if (total > BPS) revert BpsOverflow();
        if (c.dest == address(this)) revert BadDest();
        _jars.push(Jar({balance: 0, bps: c.bps, unlockAt: c.unlockAt}));
        _names.push(c.name);
        _dests.push(c.dest);
        emit JarAdded(id, c.name, c.bps, c.unlockAt, c.dest);
    }

    function _send(address to, uint256 amount) internal {
        // forge-lint: disable-next-line(arbitrary-send-eth)
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
