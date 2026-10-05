import {createPublicClient, defineChain, http} from "viem";
import type {Address} from "viem";

/**
 * BOT Chain Bohr Testnet configuration for Mandate.
 *
 * This is the target network. The legacy Arc configuration still lives in `./arc` and is what the
 * current frontend build is wired to; switching the app onto this module happens together with the
 * Mandate ABI rollout so the two never disagree.
 */

export const BOT_CHAIN_ID = 968;

export const botChain = defineChain({
  id: BOT_CHAIN_ID,
  name: "BOT Bohr Testnet",
  nativeCurrency: {name: "tBOT", symbol: "tBOT", decimals: 18},
  rpcUrls: {
    default: {http: [process.env.NEXT_PUBLIC_BOT_RPC_URL ?? "https://rpc.bohr.life"]},
  },
  blockExplorers: {
    default: {
      name: "BohrScan",
      url: process.env.NEXT_PUBLIC_BOT_EXPLORER_URL ?? "https://scan.bohr.life",
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

/**
 * Contract addresses are never hardcoded. The placeholder addresses inherited from SpendArc are
 * exactly what the migration audit flagged, so an unset value fails loudly instead of silently
 * pointing at the wrong contract.
 */
function requiredAddress(value: string | undefined, name: string): Address {
  if (!value || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new MissingMandateConfigError(name);
  return value as Address;
}

export type MandateContracts = {
  vault: Address;
  factory: Address;
};

/**
 * Read from NEXT_PUBLIC_MANDATE_VAULT_ADDRESS / NEXT_PUBLIC_MANDATE_FACTORY_ADDRESS so the vault is
 * selected per environment rather than per deployment assumption.
 */
export function mandateContracts(): MandateContracts {
  return {
    vault: requiredAddress(process.env.NEXT_PUBLIC_MANDATE_VAULT_ADDRESS, "NEXT_PUBLIC_MANDATE_VAULT_ADDRESS"),
    factory: requiredAddress(
      process.env.NEXT_PUBLIC_MANDATE_FACTORY_ADDRESS,
      "NEXT_PUBLIC_MANDATE_FACTORY_ADDRESS",
    ),
  };
}