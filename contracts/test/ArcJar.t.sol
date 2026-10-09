// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ArcJar} from "../src/ArcJar.sol";
import {ArcJarFactory} from "../src/ArcJarFactory.sol";

/// @dev Re-enters the jar when it receives a payout.
contract Reenterer {
    ArcJar public jar;
    uint8 public mode; // 1 = withdraw, 2 = sweep, 3 = collectFees
    bool public reentered;

    function setUp(ArcJar jar_, uint8 mode_) external {
        jar = jar_;
        mode = mode_;
    }

    function createJar(ArcJarFactory f, ArcJar.JarConfig[] calldata cfg) external returns (address) {
        return f.createJar(bytes32(0), cfg);
    }

    function withdraw(uint256 jarId, uint256 amount) external {
        jar.withdraw(jarId, amount, address(this));
    }

    receive() external payable {
        if (reentered) return;
        reentered = true;
        if (mode == 1) jar.withdraw(0, 1, address(this));
        else if (mode == 2) jar.sweep();
        else if (mode == 3) jar.collectFees();
    }
}

contract RejectingReceiver {
    receive() external payable {
        revert("nope");
    }
}

contract ArcJarTest is Test {
    ArcJarFactory factory;
    ArcJar jar;
    address feeRecipient = 0xc7AC1469a8dc7E4df3CE2D646dd6D01296548CEd;
    address alice = makeAddr("alice"); // jar owner
    address payer = makeAddr("payer");
    address keeper = makeAddr("keeper");
    address taxVault = makeAddr("taxVault");
    uint64 taxDay;

    uint256 constant USDC = 1e18; // native USDC unit on Arc (18 decimals)

    function setUp() public {
        vm.warp(1_760_000_000);
        taxDay = uint64(block.timestamp + 90 days);
        factory = new ArcJarFactory(feeRecipient, 20);
        jar = ArcJar(payable(_create(alice, bytes32("main"), _defaultCfg())));
        vm.deal(payer, 1_000_000 * USDC);
    }

    // ------------------------------------------------------------ helpers

    function _defaultCfg() internal view returns (ArcJar.JarConfig[] memory cfg) {
        cfg = new ArcJar.JarConfig[](2);
        cfg[0] = ArcJar.JarConfig({name: "Tax", bps: 2500, unlockAt: taxDay, dest: address(0)});
        cfg[1] = ArcJar.JarConfig({name: "Profit", bps: 500, unlockAt: 0, dest: address(0)});
    }

    function _create(address owner, bytes32 salt, ArcJar.JarConfig[] memory cfg) internal returns (address j) {
        vm.prank(owner);
        j = factory.createJar(salt, cfg);
    }

    function _pay(uint256 amount) internal {
        vm.prank(payer);
        (bool ok,) = address(jar).call{value: amount}("");
        assertTrue(ok, "payment failed");
    }

    /// @dev Simulates a USDC ERC-20 `transfer` into the jar: on Arc that moves the
    ///      same native balance but executes no code at the recipient.
    function _erc20In(uint256 amount) internal {
        vm.deal(address(jar), address(jar).balance + amount);
    }

    function _bal(uint256 id) internal view returns (uint256 b) {
        (, b,,,) = jar.jar(id);
    }

    function _assertAccounting() internal view {
        uint256 sum;
        for (uint256 i; i < jar.jarCount(); ++i) {
            sum += _bal(i);
        }
        assertEq(sum + jar.feesAccrued(), jar.allocated(), "allocated != jars + fees");
        assertGe(address(jar).balance, jar.allocated(), "insolvent");
    }

    // ------------------------------------------------------------ factory

    function test_Factory_PredictMatchesAndRegistry() public {
        address predicted = factory.predictJar(alice, bytes32("second"));
        assertEq(predicted.code.length, 0);
        address j = _create(alice, bytes32("second"), _defaultCfg());
        assertEq(j, predicted);
        address[] memory list = factory.jarsOf(alice);
        assertEq(list.length, 2);
        assertEq(list[1], j);
        assertEq(ArcJar(payable(j)).owner(), alice);
    }

    function test_Factory_SameSaltDifferentOwnersDoNotCollide() public {
        address bob = makeAddr("bob");
        assertTrue(factory.predictJar(bob, bytes32("main")) != address(jar));
        _create(bob, bytes32("main"), _defaultCfg());
    }

    function test_Factory_RevertSameOwnerSameSalt() public {
        vm.prank(alice);
        vm.expectRevert();
        factory.createJar(bytes32("main"), _defaultCfg());
    }

    function test_Factory_CloneIsTiny() public view {
        assertEq(address(jar).code.length, 45); // EIP-1167 minimal proxy
    }

    function test_RevertInitializeTwice() public {
        vm.expectRevert(ArcJar.AlreadyInitialized.selector);
        jar.initialize(payer, _defaultCfg());
    }

    function test_ImplementationIsLocked() public {
        ArcJar impl = factory.implementation();
        vm.expectRevert(ArcJar.AlreadyInitialized.selector);
        impl.initialize(payer, _defaultCfg());
    }

    function test_RevertFeeAboveMaxAtDeploy() public {
        vm.expectRevert(ArcJar.FeeTooHigh.selector);
        new ArcJarFactory(feeRecipient, 21);
        vm.expectRevert(ArcJar.ZeroAddress.selector);
        new ArcJarFactory(address(0), 20);
    }

    function test_InitialState() public view {
        assertEq(jar.jarCount(), 3);
        assertEq(jar.spendableBps(), 7000);
        (bytes32 name,,, uint64 unlockAt,) = jar.jar(1);
        assertEq(name, bytes32("Tax"));
        assertEq(unlockAt, taxDay);
        assertEq(jar.feeRecipient(), feeRecipient);
        assertEq(jar.feeBps(), 20);
        assertEq(jar.MAX_FEE_BPS(), 20);
    }

    // ------------------------------------------------------------ splitting

    function test_ReceiveSplitsImmediately() public {
        _pay(100 * USDC);
        // fee 0.2% = 0.2 USDC, net 99.8
        assertEq(jar.feesAccrued(), 0.2e18);
        assertEq(_bal(1), 24.95e18); // 25%
        assertEq(_bal(2), 4.99e18); // 5%
        assertEq(_bal(0), 69.86e18); // 70%
        assertEq(jar.unallocated(), 0);
        _assertAccounting();
    }

    function test_SplitEmitsEvent() public {
        vm.expectEmit(address(jar));
        emit ArcJar.Split(payer, 10 * USDC, 0.02e18, false);
        _pay(10 * USDC);
    }

    function test_FeeCappedAtOneUsdc() public {
        _pay(10_000 * USDC); // 0.2% would be 20 USDC
        assertEq(jar.feesAccrued(), 1 * USDC);
        assertEq(jar.feeFor(500 * USDC), 1 * USDC); // exactly at the cap
        assertEq(jar.feeFor(499 * USDC), 0.998e18);
        _assertAccounting();
    }

    function test_ZeroFeeConfig() public {
        ArcJarFactory free = new ArcJarFactory(feeRecipient, 0);
        vm.prank(alice);
        ArcJar j = ArcJar(payable(free.createJar(0, _defaultCfg())));
        vm.prank(payer);
        (bool ok,) = address(j).call{value: 1 * USDC}("");
        assertTrue(ok);
        assertEq(j.feesAccrued(), 0);
    }

    function test_DustGoesToSpendable() public {
        // 7 wei, 25% / 5%: tax gets 1, profit 0, spendable gets the rest
        _pay(7);
        assertEq(_bal(1), 1);
        assertEq(_bal(2), 0);
        assertEq(_bal(0), 6);
        _assertAccounting();
    }

    function testFuzz_SplitSumsExactly(uint96 amount, uint16 taxBps, uint16 profitBps) public {
        taxBps = uint16(bound(taxBps, 0, 10_000));
        profitBps = uint16(bound(profitBps, 0, 10_000 - taxBps));
        ArcJar.JarConfig[] memory cfg = new ArcJar.JarConfig[](2);
        cfg[0] = ArcJar.JarConfig("Tax", taxBps, 0, address(0));
        cfg[1] = ArcJar.JarConfig("Profit", profitBps, 0, address(0));
        jar = ArcJar(payable(_create(alice, bytes32("fuzz"), cfg)));
        amount = uint96(bound(amount, 1, 1_000_000 * USDC));
        _pay(amount);
        uint256 fee = jar.feeFor(amount);
        assertLe(fee, 1 * USDC);
        assertLe(fee, uint256(amount) * 20 / 10_000);
        uint256 net = uint256(amount) - fee;
        assertEq(_bal(0) + _bal(1) + _bal(2), net);
        assertEq(_bal(1), net * taxBps / 10_000);
        assertEq(_bal(2), net * profitBps / 10_000);
        // Spendable never gets less than its share
        assertGe(_bal(0), net * (10_000 - taxBps - profitBps) / 10_000);
        _assertAccounting();
    }

    function testFuzz_ManyJars(uint96 amount, uint8 count) public {
        count = uint8(bound(count, 0, 7));
        ArcJar.JarConfig[] memory cfg = new ArcJar.JarConfig[](count);
        for (uint256 i; i < count; ++i) {
            cfg[i] = ArcJar.JarConfig(bytes32(i), 1000, 0, address(0));
        }
        jar = ArcJar(payable(_create(alice, bytes32("many"), cfg)));
        amount = uint96(bound(amount, 1, 1_000_000 * USDC));
        _pay(amount);
        assertEq(jar.unallocated(), 0, "receive must fit with default wallet gas");
        _assertAccounting();
    }

    // ------------------------------------------------------------ low gas + sweep

    function test_LowGasNativePaymentRevertsSafely() public {
        uint256 before = payer.balance;
        // 2300-gas stipend (Solidity transfer/send): the clone's delegatecall alone costs more.
        vm.prank(payer);
        (bool ok,) = address(jar).call{value: 50 * USDC, gas: 2300}("");
        assertFalse(ok);
        // Too little gas for the split: reverts as a whole, payer keeps the money.
        vm.prank(payer);
        (ok,) = address(jar).call{value: 50 * USDC, gas: 30_000}("");
        assertFalse(ok);
        assertEq(payer.balance, before);
        assertEq(address(jar).balance, 0);
        // The same payer can instead pay via the ERC-20 interface; a keeper sweeps it.
        _erc20In(50 * USDC);
        vm.prank(keeper);
        assertEq(jar.sweep(), 50 * USDC);
        assertEq(_bal(1), 12.475e18);
        _assertAccounting();
    }

    function test_SweepErc20Transfers() public {
        _pay(10 * USDC);
        _erc20In(40 * USDC); // e.g. an exchange withdrawal through the ERC-20 interface
        assertEq(jar.unallocated(), 40 * USDC);
        vm.expectEmit(address(jar));
        emit ArcJar.Split(keeper, 40 * USDC, 0.08e18, true);
        vm.prank(keeper);
        jar.sweep();
        assertEq(jar.feesAccrued(), 0.1e18);
        _assertAccounting();
    }

    function test_ReceiveDoesNotTouchEarlierUnsweptFunds() public {
        _erc20In(5 * USDC);
        _pay(10 * USDC);
        assertEq(jar.unallocated(), 5 * USDC);
        _assertAccounting();
    }

    function test_RevertSweepNothing() public {
        vm.expectRevert(ArcJar.NothingToSweep.selector);
        jar.sweep();
        _pay(1 * USDC);
        vm.expectRevert(ArcJar.NothingToSweep.selector);
        jar.sweep();
    }

    // ------------------------------------------------------------ withdraw + locks

    function test_WithdrawSpendable() public {
        _pay(100 * USDC);
        vm.prank(alice);
        jar.withdraw(0, 60 * USDC, alice);
        assertEq(alice.balance, 60 * USDC);
        assertEq(_bal(0), 9.86e18);
        _assertAccounting();
    }

    function test_WithdrawAllWithMax() public {
        _pay(100 * USDC);
        vm.prank(alice);
        jar.withdraw(2, type(uint256).max, alice);
        assertEq(alice.balance, 4.99e18);
        assertEq(_bal(2), 0);
    }

    function test_TimeLockBlocksUntilUnlock() public {
        _pay(100 * USDC);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ArcJar.Locked.selector, taxDay));
        jar.withdraw(1, 1, alice);

        vm.warp(taxDay - 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ArcJar.Locked.selector, taxDay));
        jar.withdraw(1, 1, alice);

        vm.warp(taxDay);
        vm.prank(alice);
        jar.withdraw(1, type(uint256).max, alice);
        assertEq(alice.balance, 24.95e18);
    }

    function test_ExtendLockOnlyForward() public {
        vm.startPrank(alice);
        vm.expectRevert(ArcJar.LockShortened.selector);
        jar.extendLock(1, taxDay - 1);
        vm.expectRevert(ArcJar.LockShortened.selector);
        jar.extendLock(1, taxDay);
        jar.extendLock(1, taxDay + 1 days);
        vm.expectRevert(ArcJar.LockTooFar.selector);
        jar.extendLock(1, uint64(block.timestamp + 3651 days));
        // lock a previously unlocked jar
        jar.extendLock(2, uint64(block.timestamp + 7 days));
        vm.stopPrank();
        _pay(10 * USDC);
        vm.prank(alice);
        vm.expectRevert();
        jar.withdraw(2, 1, alice);
    }

    function test_DestOverridesRecipient() public {
        vm.prank(alice);
        jar.setDest(2, taxVault);
        _pay(100 * USDC);
        vm.prank(alice);
        jar.withdraw(2, 1 * USDC, alice); // `to` ignored
        assertEq(taxVault.balance, 1 * USDC);
        assertEq(alice.balance, 0);
    }

    function test_RevertWithdrawGuards() public {
        _pay(10 * USDC);
        vm.prank(payer);
        vm.expectRevert(ArcJar.NotOwner.selector);
        jar.withdraw(0, 1, payer);

        vm.startPrank(alice);
        vm.expectRevert(ArcJar.BadJar.selector);
        jar.withdraw(9, 1, alice);
        vm.expectRevert(ArcJar.ZeroAddress.selector);
        jar.withdraw(0, 1, address(0));
        vm.expectRevert(ArcJar.ZeroAddress.selector);
        jar.withdraw(0, 1, address(jar));
        vm.expectRevert(ArcJar.InsufficientJarBalance.selector);
        jar.withdraw(0, 100 * USDC, alice);
        vm.expectRevert(ArcJar.InsufficientJarBalance.selector);
        jar.withdraw(0, 0, alice);
        vm.stopPrank();
    }

    function test_RevertWithdrawToRejectingReceiver() public {
        _pay(10 * USDC);
        address r = address(new RejectingReceiver());
        vm.prank(alice);
        vm.expectRevert(ArcJar.TransferFailed.selector);
        jar.withdraw(0, 1, r);
        _assertAccounting();
    }

    // ------------------------------------------------------------ config

    function test_SetSplits() public {
        uint16[] memory bps = new uint16[](2);
        bps[0] = 3000;
        bps[1] = 0;
        vm.prank(alice);
        jar.setSplits(bps);
        assertEq(jar.spendableBps(), 7000);
        _pay(10 * USDC);
        assertEq(_bal(2), 0);
        assertEq(_bal(1), 2.994e18);
    }

    function test_RevertSetSplitsBad() public {
        uint16[] memory bps = new uint16[](2);
        bps[0] = 9000;
        bps[1] = 1001;
        vm.startPrank(alice);
        vm.expectRevert(ArcJar.BpsOverflow.selector);
        jar.setSplits(bps);
        vm.expectRevert(ArcJar.LengthMismatch.selector);
        jar.setSplits(new uint16[](1));
        vm.stopPrank();
        vm.expectRevert(ArcJar.NotOwner.selector);
        jar.setSplits(bps);
    }

    function test_AddJarLimits() public {
        vm.startPrank(alice);
        for (uint256 i; i < 5; ++i) {
            jar.addJar(ArcJar.JarConfig(bytes32(i), 100, 0, address(0)));
        }
        assertEq(jar.jarCount(), 8);
        vm.expectRevert(ArcJar.TooManyJars.selector);
        jar.addJar(ArcJar.JarConfig("x", 0, 0, address(0)));
        vm.stopPrank();
    }

    function test_RevertAddJarBpsOverflowAndLockTooFar() public {
        vm.startPrank(alice);
        vm.expectRevert(ArcJar.BpsOverflow.selector);
        jar.addJar(ArcJar.JarConfig("x", 7001, 0, address(0)));
        vm.expectRevert(ArcJar.LockTooFar.selector);
        jar.addJar(ArcJar.JarConfig("x", 1, uint64(block.timestamp + 3651 days), address(0)));
        vm.stopPrank();
    }

    function test_TransferOwnership() public {
        address bob = makeAddr("bob");
        vm.prank(alice);
        jar.transferOwnership(bob);
        assertEq(jar.owner(), bob);
        _pay(1 * USDC);
        vm.prank(alice);
        vm.expectRevert(ArcJar.NotOwner.selector);
        jar.withdraw(0, 1, alice);
        vm.prank(bob);
        jar.withdraw(0, 1, bob);
        vm.prank(bob);
        vm.expectRevert(ArcJar.ZeroAddress.selector);
        jar.transferOwnership(address(0));
    }

    // ------------------------------------------------------------ fees

    function test_CollectFeesByAnyone() public {
        _pay(100 * USDC);
        _pay(1000 * USDC);
        vm.prank(keeper);
        assertEq(jar.collectFees(), 1.2e18);
        assertEq(feeRecipient.balance, 1.2e18);
        assertEq(jar.feesAccrued(), 0);
        assertEq(jar.collectFees(), 0);
        _assertAccounting();
    }

    // ------------------------------------------------------------ reentrancy

    function _reentrantJar(uint8 mode) internal returns (Reenterer r) {
        r = new Reenterer();
        jar = ArcJar(payable(r.createJar(factory, _defaultCfg())));
        r.setUp(jar, mode);
        _pay(100 * USDC);
    }

    function test_ReentrancyWithdrawBlocked() public {
        Reenterer r = _reentrantJar(1);
        vm.expectRevert(ArcJar.TransferFailed.selector);
        r.withdraw(0, 1 * USDC);
        _assertAccounting();
    }

    function test_ReentrancySweepBlocked() public {
        Reenterer r = _reentrantJar(2);
        _erc20In(5 * USDC);
        vm.expectRevert(ArcJar.TransferFailed.selector);
        r.withdraw(0, 1 * USDC);
        _assertAccounting();
    }

    function test_ReentrancyCollectFeesBlocked() public {
        Reenterer r = _reentrantJar(3);
        vm.expectRevert(ArcJar.TransferFailed.selector);
        r.withdraw(0, 1 * USDC);
    }

    // ------------------------------------------------------------ gas

    function test_GasReceiveFitsBudget() public {
        // Worst case: 8 jars, all slots cold-to-nonzero.
        ArcJar.JarConfig[] memory cfg = new ArcJar.JarConfig[](7);
        for (uint256 i; i < 7; ++i) {
            cfg[i] = ArcJar.JarConfig(bytes32(i), 1000, 0, address(0));
        }
        jar = ArcJar(payable(_create(alice, bytes32("gas"), cfg)));
        uint256 g = gasleft();
        _pay(1 * USDC);
        uint256 used = g - gasleft();
        emit log_named_uint("receive gas, 8 jars, first payment", used);
        assertLt(used, 200_000);
        assertEq(jar.unallocated(), 0);
    }
}

/// @dev Invariant: jars + fees always equal `allocated`, and the contract is always solvent.
contract Handler is Test {
    ArcJar public jar;
    address public owner;

    constructor(ArcJar jar_, address owner_) {
        jar = jar_;
        owner = owner_;
    }

    function pay(uint96 amount) external {
        amount = uint96(bound(amount, 1, 1e24));
        vm.deal(address(this), amount);
        (bool ok,) = address(jar).call{value: amount}("");
        require(ok);
    }

    function erc20In(uint96 amount) external {
        vm.deal(address(jar), address(jar).balance + bound(amount, 1, 1e24));
    }

    function sweep() external {
        if (jar.unallocated() > 0) jar.sweep();
    }

    function withdraw(uint8 id, uint96 amount) external {
        id = uint8(bound(id, 0, jar.jarCount() - 1));
        (, uint256 bal,, uint64 unlockAt,) = jar.jar(id);
        if (bal == 0 || block.timestamp < unlockAt) return;
        vm.prank(owner);
        jar.withdraw(id, bound(amount, 1, bal), owner);
    }

    function collect() external {
        jar.collectFees();
    }

    function warp(uint32 dt) external {
        vm.warp(block.timestamp + bound(dt, 0, 30 days));
    }
}

contract ArcJarInvariantTest is Test {
    ArcJar jar;
    Handler handler;

    function setUp() public {
        vm.warp(1_760_000_000);
        ArcJarFactory f = new ArcJarFactory(address(0xFEE), 20);
        ArcJar.JarConfig[] memory cfg = new ArcJar.JarConfig[](2);
        cfg[0] = ArcJar.JarConfig("Tax", 2500, uint64(block.timestamp + 60 days), address(0));
        cfg[1] = ArcJar.JarConfig("Profit", 500, 0, address(0));
        address owner = address(0xA11CE);
        vm.prank(owner);
        jar = ArcJar(payable(f.createJar(0, cfg)));
        handler = new Handler(jar, owner);
        targetContract(address(handler));
    }

    function invariant_AccountingAndSolvency() public view {
        uint256 sum;
        for (uint256 i; i < jar.jarCount(); ++i) {
            (, uint256 b,,,) = jar.jar(i);
            sum += b;
        }
        assertEq(sum + jar.feesAccrued(), jar.allocated());
        assertGe(address(jar).balance, jar.allocated());
    }

    function invariant_FeeNeverAboveMax() public view {
        assertLe(jar.feeBps(), jar.MAX_FEE_BPS());
    }
}
