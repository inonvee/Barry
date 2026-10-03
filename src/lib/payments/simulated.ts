/**
 * TEST MONEY — the one rule for which payment records are simulated. A payment on a simulated provider
 * (or with no provider at all) is test money: it is never counted as revenue anywhere, and it is the ONLY
 * kind of payment a simulator may settle. A real provider's payment changes state only through that
 * provider's verified webhook or status lookup.
 */
export function isSimulatedPaymentProvider(provider: string | undefined | null): boolean {
  return !provider || /^(memory|mock|simulat)/i.test(provider);
}

export class SimulatedPaymentRefusedError extends Error {
  constructor(provider: string) {
    super(`A simulator cannot settle a payment on the real provider "${provider}"; only the provider's verification can.`);
    this.name = "SimulatedPaymentRefusedError";
  }
}
