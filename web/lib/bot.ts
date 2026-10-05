import {createPublicClient, defineChain, http} from "viem";
import type {Address} from "viem";

/**
 * BOT Chain Bohr Testnet configuration for Mandate.
 *
 * This is the target network, and the only network configuration in the app. The legacy Arc setup
 * was removed during the Mandate migration, so there is no second chain object that a caller could
 * accidentally read balances from.
 */

export const BOT_CHAIN_ID = 968;

/** Resolved endpoints, exported so the settings page can display what the app is actually using. */
export const BOT_RPC_URL = process.env.NEXT_PUBLIC_BOT_RPC_URL ?? "https://rpc.bohr.life";
export const BOT_EXPLORER_URL = process.env.NEXT_PUBLIC_BOT_EXPLORER_URL ?? "https://scan.bohr.life";

export const botChain = defineChain({
  id: BOT_CHAIN_ID,
  name: "BOT Bohr Testnet",
  nativeCurrency: {name: "tBOT", symbol: "tBOT", decimals: 18},
  rpcUrls: {
    default: {http: [BOT_RPC_URL]},
  },
  blockExplorers: {
    default: {
      name: "BohrScan",
      url: BOT_EXPLORER_URL,
    },
  },
  testnet: true,
});

/** Settlement token on BOT Chain Bohr Testnet. */
export const TUSDT_ADDRESS = "0x75edC9335175Fc0552D51D48439F229c10420fe3" as Address;
export const TUSDT_DECIMALS = 6;

export const botPublicClient = createPublicClient({chain: botChain, transport: http()});

const explorer = () => botChain.blockExplorers.default.url.replace(/\/$/, "");

export const botExplorerTx = (hash: string) => `${explorer()}/tx/${hash}`;
export const botExplorerAddress = (address: string) => `${explorer()}/address/${address}`;

export class MissingMandateConfigError extends Error {
  constructor(name: string) {
    super(
      `Missing ${name}. Set it in web/.env.local, e.g. ${name}=0xYourAddress. ` +
        `Deploy with: forge script script/DeployMandateFactory.s.sol --rpc-url ${botChain.rpcUrls.default.http[0]} --broadcast`,
    );
    this.name = "MissingMandateConfigError";
  }
}

/** The zero address, which is how the factory reports "this org has no vault yet". */
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

/**
 * Contract addresses are never hardcoded. The placeholder addresses inherited from SpendArc are
 * exactly what the migration audit flagged, so an unset value fails loudly instead of silently
 * pointing at the wrong contract.
 */
function requiredAddress(value: string | undefined, name: string): Address {
  if (!value || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new MissingMandateConfigError(name);
  return value as Address;
}

/**
 * The factory is the ONLY deployment-wide address.
 *
 * The vault is deliberately not configured here. One org gets one vault, and which vault that is
 * depends on who is asking: it is resolved per connected address from `vaultOf(address)`. A single
 * hardcoded vault address would be wrong the moment a second org onboarded, and would silently let
 * one org's UI read another org's treasury.
 */
export function mandateFactory(): Address {
  return requiredAddress(
    process.env.NEXT_PUBLIC_MANDATE_FACTORY_ADDRESS,
    "NEXT_PUBLIC_MANDATE_FACTORY_ADDRESS",
  );
}