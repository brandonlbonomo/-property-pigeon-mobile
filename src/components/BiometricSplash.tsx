import React, { useEffect, useRef } from 'react';
import { View, Image, Animated, StyleSheet } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import { Colors } from '../constants/theme';

interface Props {
  onSuccess: () => void;
  onFallback: () => void;
}

export function BiometricSplash({ onSuccess, onFallback }: Props) {
  const opacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    (async () => {
      try {
        const result = await LocalAuthentication.authenticateAsync({
          promptMessage: 'Sign in to Portfolio Pigeon',
        });
        if (result.success) {
          Animated.timing(opacity, {
            toValue: 0,
            duration: 400,
            useNativeDriver: true,
          }).start(() => onSuccess());
        } else {
          onFallback();
        }
      } catch {
        onFallback();
      }
    })();
  }, []);

  return (
    <Animated.View style={[styles.container, { opacity }]}>
      <Image source={require('../../assets/splash-icon.png')} style={styles.logo} />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logo: {
    width: 120,
    height: 120,
    resizeMode: 'contain',
  },
});
