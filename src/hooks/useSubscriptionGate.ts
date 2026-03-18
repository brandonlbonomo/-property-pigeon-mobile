import { useUserStore } from '../store/userStore';

export function useSubscriptionGate() {
  const profile = useUserStore(s => s.profile);

  const isFounder = profile?.isFounder === true;
  const lifetimeFree = profile?.lifetimeFree === true;
  const subscriptionActive = profile?.isSubscriptionActive === true;

  const isActive = isFounder || lifetimeFree || subscriptionActive;
  const isReadOnly = !isActive;

  return { isActive, isReadOnly, isFounder, lifetimeFree };
}
