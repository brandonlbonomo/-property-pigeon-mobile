import React, { useEffect } from 'react';
import { View, StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';

import { useAuthStore } from './src/store/authStore';
import { AppNavigator } from './src/navigation/AppNavigator';
import { LoginScreen } from './src/screens/auth/LoginScreen';
import { LoadingScreen } from './src/components/LoadingScreen';
import { Colors } from './src/constants/theme';

export default function App() {
  const { token, isLoading, hydrate } = useAuthStore();

  useEffect(() => {
    hydrate();
  }, []);

  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <StatusBar style="light" backgroundColor={Colors.bg} />
        {isLoading ? (
          <LoadingScreen />
        ) : token ? (
          <AppNavigator />
        ) : (
          <View style={styles.authContainer}>
            <LoginScreen />
          </View>
        )}
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.bg },
  authContainer: { flex: 1, backgroundColor: Colors.bg },
});
