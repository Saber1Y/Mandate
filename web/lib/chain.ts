import {botChain, botExplorerAddress, botExplorerTx, botPublicClient} from "./bot";

/**
 * Shared read client for the chain Mandate targets: BOT Chain Bohr Testnet.
 *
 * There is no second network configuration. Arc/SpendArc was removed during the migration; if you
 * find yourself wanting to re-add a parallel chain here, do not - a second source of truth for
 * chain identity is exactly the class of drift the migration audit flagged.
 */
export const publicClient = botPublicClient;
export const targetChain = botChain;
export const explorerTx = botExplorerTx;
export const explorerAddress = botExplorerAddress;