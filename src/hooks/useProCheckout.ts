import { useState, useCallback } from 'react';
import { showProPaywall, PaywallResult } from '../components/ProPaywallModal';

/** Custom checkout hook — shows our own paywall modal. */
export { type PaywallResult } from '../components/ProPaywallModal';

export function useProCheckout() {
  const [loading, setLoading] = useState(false);

  const startCheckout = useCallback(async (): Promise<PaywallResult> => {
    setLoading(true);
    try {
      const result = await showProPaywall();
      return result;
    } finally {
      setLoading(false);
    }
  }, []);

  return { loading, startCheckout };
}
