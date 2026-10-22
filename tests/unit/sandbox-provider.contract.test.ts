// O sandbox cumpre o mesmo contrato exigido de qualquer PSP real.

import { describePaymentProviderContract } from '../contract/payment-provider.contract.ts';
import { SANDBOX_SIGNATURE_HEADER, REPLAY_WINDOW_SECONDS, SandboxProvider } from '../../src/modules/payments/providers.ts';

const SECRET = 'segredo-de-teste-do-contrato-123';

describePaymentProviderContract('sandbox', () => {
  const provider = new SandboxProvider(SECRET);
  const ref = (r: string) => (/^sbx_[0-9a-f]{24}$/.test(r) ? r : `sbx_${'a'.repeat(24)}`);
  return {
    provider,
    fixtures: {
      valid(event, at) {
        const w = provider.buildWebhook({ ...event, reference: ref(event.reference) }, at);
        return { rawBody: Buffer.from(w.body), headers: { [SANDBOX_SIGNATURE_HEADER]: w.signature } };
      },
      unsigned(event, at) {
        const w = provider.buildWebhook({ ...event, reference: ref(event.reference) }, at);
        return { rawBody: Buffer.from(w.body), headers: {} };
      },
      referencePattern: /^sbx_[0-9a-f]{24}$/,
      replayWindowSeconds: REPLAY_WINDOW_SECONDS,
    },
  };
});
