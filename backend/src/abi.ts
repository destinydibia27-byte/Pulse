import { parseAbi } from "viem";

/**
 * getPermission is declared with FLAT outputs on purpose: the contract returns a struct of
 * only static types, which ABI-encodes identically to a flat list, and chain.ts reads the
 * result positionally. Field order MUST match the Solidity `Permission` struct:
 *   [0]owner [1]asset [2]recipient [3]maxPerExecution [4]maxPerWindow [5]windowSeconds
 *   [6]expiresAt [7]windowStart [8]spentInWindow [9]status [10]weekday [11]conditionOp
 *   [12]conditionThreshold [13]lastExecutionDay
 */
export const PULSE_ABI = parseAbi([
  "function createPermission(address asset, address recipient, uint256 maxPerExecution, uint256 maxPerWindow, uint256 windowSeconds, uint256 expiresAt, uint8 weekday, uint8 conditionOp, uint256 conditionThreshold) returns (uint256 id)",
  "function execute(uint256 id, uint256 amount)",
  "function pause(uint256 id)",
  "function resume(uint256 id)",
  "function cancel(uint256 id)",
  "function executor() view returns (address)",
  "function getPermission(uint256 id) view returns (address owner, address asset, address recipient, uint256 maxPerExecution, uint256 maxPerWindow, uint256 windowSeconds, uint256 expiresAt, uint256 windowStart, uint256 spentInWindow, uint8 status, uint8 weekday, uint8 conditionOp, uint256 conditionThreshold, uint256 lastExecutionDay)",
  "event PermissionCreated(uint256 indexed id, address indexed owner, address asset, address recipient, uint256 maxPerExecution, uint256 maxPerWindow, uint256 windowSeconds, uint256 expiresAt, uint8 weekday, uint8 conditionOp, uint256 conditionThreshold)",
  "event Executed(uint256 indexed id, uint256 amount, address recipient)",
  "event ExecutionRejected(uint256 indexed id, string reason)",
]);

export const ERC20_ABI = parseAbi([
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address account) view returns (uint256)",
]);
