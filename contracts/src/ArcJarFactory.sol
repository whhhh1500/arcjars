// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {ArcJar} from "./ArcJar.sol";

/// @title ArcJarFactory — deploys one cheap EIP-1167 clone of {ArcJar} per user
/// @notice Addresses are deterministic (owner + salt), so a "pay me" link can be
///         shared before the jar even exists on-chain.
contract ArcJarFactory {
    ArcJar public immutable implementation;

    /// @notice All jars ever created by an owner (UI convenience).
    mapping(address owner => address[]) internal _jarsOf;
    /// @notice True for every jar this factory deployed.
    mapping(address jar => bool) public isJar;

    event JarCreated(address indexed owner, address indexed jar, bytes32 salt);
    event JarOwnerChanged(address indexed jar, address indexed previousOwner, address indexed newOwner);

    error NotAJar();

    constructor(address feeRecipient, uint16 feeBps) {
        implementation = new ArcJar(feeRecipient, feeBps);
    }

    /// @notice Create a jar owned by the caller.
    function createJar(bytes32 salt, ArcJar.JarConfig[] calldata configs) external returns (address jar) {
        jar = Clones.cloneDeterministic(address(implementation), _salt(msg.sender, salt));
        isJar[jar] = true;
        ArcJar(payable(jar)).initialize(msg.sender, configs);
        _jarsOf[msg.sender].push(jar);
        emit JarCreated(msg.sender, jar, salt);
    }

    /// @notice Called by a jar when its two-step ownership transfer completes, so the new
    ///         owner finds the jar via {jarsOf}. The previous owner's list keeps the entry
    ///         (append-only); clients should filter on `ArcJar.owner()`.
    function recordOwnerChange(address previousOwner, address newOwner) external {
        if (!isJar[msg.sender]) revert NotAJar();
        _jarsOf[newOwner].push(msg.sender);
        emit JarOwnerChanged(msg.sender, previousOwner, newOwner);
    }

    function predictJar(address owner, bytes32 salt) external view returns (address) {
        return Clones.predictDeterministicAddress(address(implementation), _salt(owner, salt), address(this));
    }

    function jarsOf(address owner) external view returns (address[] memory) {
        return _jarsOf[owner];
    }

    function _salt(address owner, bytes32 salt) internal pure returns (bytes32) {
        return keccak256(abi.encode(owner, salt));
    }
}
