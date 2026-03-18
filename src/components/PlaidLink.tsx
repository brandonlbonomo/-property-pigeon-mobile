import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import { create, open, dismissLink } from 'react-native-plaid-link-sdk';

interface Props {
  visible: boolean;
  linkToken: string;
  onSuccess: (publicToken: string, accountName: string) => void;
  onExit: (error?: any) => void;
}

export function PlaidLinkModal({ visible, linkToken, onSuccess, onExit }: Props) {
  // Use refs so the native callbacks always call the latest version
  const onSuccessRef = useRef(onSuccess);
  const onExitRef = useRef(onExit);
  const hasOpened = useRef(false);
  onSuccessRef.current = onSuccess;
  onExitRef.current = onExit;

  useEffect(() => {
    if (!visible || !linkToken || hasOpened.current) return;

    hasOpened.current = true;

    try {
      create({
        token: linkToken,
        onLoad: () => {
          open({
            onSuccess: (result) => {
              hasOpened.current = false;
              const name = result.metadata?.institution?.name || 'Bank Account';
              onSuccessRef.current(result.publicToken, name);
            },
            onExit: (result) => {
              hasOpened.current = false;
              if (result.error) {
                onExitRef.current({
                  error_code: result.error.errorCode,
                  error_message: result.error.errorMessage || result.error.displayMessage,
                });
              } else {
                onExitRef.current();
              }
            },
          });
        },
      });
    } catch (e) {
      hasOpened.current = false;
      onExitRef.current({ error_message: 'Failed to initialize Plaid Link' });
    }

    return () => {
      if (Platform.OS === 'ios') {
        dismissLink();
      }
      hasOpened.current = false;
    };
  }, [visible, linkToken]);

  // Native SDK renders its own UI — no React elements needed
  return null;
}
