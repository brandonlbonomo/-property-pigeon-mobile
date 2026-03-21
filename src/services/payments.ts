import { apiFetch } from './api';

/**
 * Stripe Connect onboarding for cleaners.
 * Returns the onboarding URL to open in a webview.
 */
export async function startConnectOnboarding(): Promise<{
  ok: boolean;
  status: 'active' | 'pending' | 'not_started';
  onboarding_url?: string;
  connect_id?: string;
  error?: string;
}> {
  return apiFetch('/api/connect/onboard', { method: 'POST' });
}

/**
 * Check if the cleaner has completed Stripe Connect setup.
 */
export async function getConnectStatus(): Promise<{
  connected: boolean;
  status: 'active' | 'pending' | 'not_started' | 'error';
  connect_id?: string;
}> {
  return apiFetch('/api/connect/status');
}

/**
 * Create a PaymentIntent for an invoice.
 * Returns client_secret for the Stripe Payment Sheet.
 */
export async function createInvoicePaymentIntent(
  invoiceId: string,
  amountCents: number,
  cleanerUserId: string,
): Promise<{
  client_secret: string;
  payment_intent_id: string;
  publishable_key: string;
  error?: string;
}> {
  return apiFetch('/api/invoice/payment-intent', {
    method: 'POST',
    body: JSON.stringify({
      invoice_id: invoiceId,
      amount_cents: amountCents,
      cleaner_user_id: cleanerUserId,
    }),
  });
}

/**
 * Check payment status after Apple Pay completes.
 */
export async function checkPaymentStatus(paymentIntentId: string): Promise<{
  status: string;
  invoice_id: string;
  amount: number;
}> {
  return apiFetch('/api/invoice/payment-status', {
    method: 'POST',
    body: JSON.stringify({ payment_intent_id: paymentIntentId }),
  });
}
