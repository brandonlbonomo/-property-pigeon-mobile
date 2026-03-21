import React, { useState, useEffect } from 'react';
import {
  View, Text, Image, TextInput, TouchableOpacity, StyleSheet,
  KeyboardAvoidingView, ScrollView, Platform, Alert, ActivityIndicator,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Colors, FontSize, Spacing, Radius } from '../../constants/theme';
import { useOnboardingStore } from '../../store/onboardingStore';
import { useUserStore } from '../../store/userStore';
import { apiLogin, setToken } from '../../services/api';
import { glassAlert } from '../../components/GlassAlert';

export function SignInScreen({ navigation }: any) {
  const insets = useSafeAreaInsets();
  const [email, setEmail] = useState('');

  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [hasStoredEmail, setHasStoredEmail] = useState(false);
  const [loading, setLoading] = useState(false);
  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const complete = useOnboardingStore(s => s.complete);
  const setBiometric = useOnboardingStore(s => s.setBiometric);
  const setProfile = useUserStore(s => s.setProfile);

  useEffect(() => {
    prefillEmail();
    checkBiometricHardware();
    tryBiometricAuto();
  }, []);

  const prefillEmail = async () => {
    try {
      const storedEmail = await SecureStore.getItemAsync('pp_email');
      if (storedEmail) {
        setEmail(storedEmail);
        setHasStoredEmail(true);
      }
    } catch {
      // ignore
    }
  };

  const checkBiometricHardware = async () => {
    try {
      const compatible = await LocalAuthentication.hasHardwareAsync();
      const enrolled = await LocalAuthentication.isEnrolledAsync();
      setBiometricAvailable(compatible && enrolled);
    } catch {
      setBiometricAvailable(false);
    }
  };

  // Auto-trigger on mount — only if biometric was previously enabled
  const tryBiometricAuto = async () => {
    try {
      const bioEnabled = await SecureStore.getItemAsync('pp_biometric');
      if (bioEnabled !== 'true') return;

      const storedToken = await SecureStore.getItemAsync('pp_token');
      if (!storedToken) return;

      const compatible = await LocalAuthentication.hasHardwareAsync();
      const enrolled = await LocalAuthentication.isEnrolledAsync();
      if (!compatible || !enrolled) return;

      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: 'Sign in to Portfolio Pigeon',
        fallbackLabel: 'Use password',
      });

      if (result.success) {
        await restoreWithToken(storedToken);
      }
    } catch {
      // Fall through to password form
    }
  };

  // Manual button press — does NOT require pp_biometric flag
  const tryBiometricManual = async () => {
    try {
      const storedToken = await SecureStore.getItemAsync('pp_token');
      if (!storedToken) {
        glassAlert('Not Available', 'Sign in with your password first to enable Face ID / Touch ID for future logins.');
        return;
      }

      const compatible = await LocalAuthentication.hasHardwareAsync();
      const enrolled = await LocalAuthentication.isEnrolledAsync();
      if (!compatible || !enrolled) {
        glassAlert('Not Available', 'Biometric authentication is not set up on this device.');
        return;
      }

      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: 'Sign in to Portfolio Pigeon',
        fallbackLabel: 'Use password',
      });

      if (result.success) {
        // Enable biometric for future auto-login
        await setBiometric(true);
        await restoreWithToken(storedToken);
      }
    } catch {
      glassAlert('Error', 'Biometric authentication failed. Please use your password.');
    }
  };

  const restoreWithToken = async (token: string) => {
    setToken(token);

    const storedEmail = await SecureStore.getItemAsync('pp_email');
    const storedPortfolio = await SecureStore.getItemAsync('pp_portfolio_type') as 'str' | 'ltr' | 'both' | null;
    const storedUsername = await SecureStore.getItemAsync('pp_username');

    await setProfile({
      email: storedEmail || '',
      username: storedUsername || undefined,
      portfolioType: storedPortfolio || 'str',
      properties: [],
      hasActivatedData: true,
    });

    await complete(storedPortfolio);
  };

  const promptBiometricEnrollment = async () => {
    try {
      const compatible = await LocalAuthentication.hasHardwareAsync();
      const enrolled = await LocalAuthentication.isEnrolledAsync();
      if (!compatible || !enrolled) return;

      const bioEnabled = await SecureStore.getItemAsync('pp_biometric');
      if (bioEnabled === 'true') return; // Already enabled

      glassAlert(
        'Enable Face ID',
        'Would you like to use Face ID / Touch ID for quick sign-in next time?',
        [
          { text: 'Not Now', style: 'cancel' },
          { text: 'Enable', onPress: () => setBiometric(true) },
        ]
      );
    } catch {
      // ignore
    }
  };

  const isValidEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/.test(e);

  const handleSignIn = async () => {
    if (!email.trim() || !password.trim()) {
      glassAlert('Required', 'Enter your email or username and password');
      return;
    }

    setLoading(true);
    try {
      const res = await apiLogin(email.trim().toLowerCase(), password);

      await SecureStore.setItemAsync('pp_token', res.token);
      await SecureStore.setItemAsync('pp_email', res.email);
      if (res.username) await SecureStore.setItemAsync('pp_username', res.username);

      // Determine account type from backend role (GAP 1/2/3 fix)
      const role = res.role || 'owner';
      const isCleaner = role === 'cleaner';
      const storedPortfolio = isCleaner
        ? null  // GAP 4: portfolioType is meaningless for cleaners
        : (await SecureStore.getItemAsync('pp_portfolio_type') as 'str' | 'ltr' | 'both' | null);

      // Preserve existing properties — don't wipe them on login
      const existingProps = useUserStore.getState().profile?.properties;
      await setProfile({
        email: res.email,
        username: res.username || undefined,
        accountType: isCleaner ? 'cleaner' : 'owner',
        portfolioType: isCleaner ? undefined : (storedPortfolio || 'str'),
        ...(existingProps?.length ? {} : { properties: [] }), // Only set empty if no existing
        hasActivatedData: true,
      });

      // Prompt biometric enrollment before completing (so user sees it)
      await promptBiometricEnrollment();

      await complete(isCleaner ? 'str' : storedPortfolio);
    } catch (err: any) {
      const msg = err.serverError || err.message || 'Sign in failed';
      glassAlert('Error', msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={[styles.scroll, { paddingTop: insets.top + Spacing.sm }]} keyboardShouldPersistTaps="handled">
        <TouchableOpacity activeOpacity={0.7}
          style={styles.backBtn} onPress={() => navigation.goBack()}>
          <Ionicons name="chevron-back" size={20} color={Colors.primary} />
          <Text style={styles.backText}>Back</Text>
        </TouchableOpacity>

        <View style={styles.hero}>
          <Image
            source={require('../../../assets/logo.png')}
            style={styles.logo}
          />
          <Text style={styles.title}>Welcome back</Text>
          <Text style={styles.subtitle}>Sign in to your Portfolio Pigeon account</Text>
        </View>

        <Text style={styles.label}>Email or Username</Text>
        <TextInput
          style={styles.input}
          value={email}
          onChangeText={setEmail}
          placeholder="Enter your email or username"
          placeholderTextColor={Colors.textDim}
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={254}
        />

        <Text style={styles.label}>Password</Text>
        <View style={[styles.input, styles.passwordRow]}>
          <TextInput
            style={styles.passwordInput}
            value={password}
            onChangeText={setPassword}
            placeholder="Enter your password"
            placeholderTextColor={Colors.textDim}
            secureTextEntry={!showPassword}
            maxLength={128}
          />
          <TouchableOpacity activeOpacity={0.7}
          onPress={() => setShowPassword(!showPassword)} style={styles.eyeBtn}>
            <Ionicons name={showPassword ? 'eye-off' : 'eye'} size={20} color={Colors.textDim} />
          </TouchableOpacity>
        </View>

        {/* Forgot Password */}
        <TouchableOpacity activeOpacity={0.7}
          style={styles.forgotBtn}
          onPress={() => navigation.navigate('ForgotPassword')}
        >
          <Text style={styles.forgotText}>Forgot Password?</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.primaryBtn, loading && styles.btnDisabled]}
          onPress={() => {
            if (!email.trim() || !password.trim()) {
              glassAlert('Required', 'Enter your email and password');
              return;
            }
            handleSignIn();
          }}
          activeOpacity={0.7}
        >
          {loading ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <Text style={styles.primaryBtnText}>Sign In</Text>
          )}
        </TouchableOpacity>

        {/* Biometric — only show if device supports it */}
        {biometricAvailable && (
          <TouchableOpacity activeOpacity={0.7}
          style={styles.biometricBtn} onPress={tryBiometricManual}>
            <Ionicons name="finger-print-outline" size={22} color={Colors.primary} />
            <Text style={styles.biometricText}>Use Face ID / Touch ID</Text>
          </TouchableOpacity>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  scroll: { flexGrow: 1, padding: Spacing.lg },
  backBtn: { flexDirection: 'row', alignItems: 'center', gap: 2, marginBottom: Spacing.lg },
  backText: { fontSize: FontSize.md, color: Colors.primary },
  hero: { alignItems: 'center', marginBottom: Spacing.xl },
  logo: {
    width: 88, height: 88,
    marginBottom: Spacing.md,
  },
  title: { fontSize: FontSize.xl, fontWeight: '700', color: Colors.text, marginBottom: Spacing.xs },
  subtitle: { fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center' },
  label: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '500', marginBottom: Spacing.xs, marginTop: Spacing.md },
  input: {
    backgroundColor: Colors.glassHeavy, borderWidth: 1, borderColor: Colors.border,
    borderRadius: Radius.md, padding: Spacing.md, color: Colors.text, fontSize: FontSize.md,
  },
  inputRow: { flexDirection: 'row', alignItems: 'center' },
  eyeIcon: { position: 'absolute', right: 12 },
  passwordRow: { flexDirection: 'row', alignItems: 'center', paddingRight: Spacing.xs },
  passwordInput: { flex: 1, fontSize: FontSize.md, color: Colors.text, paddingVertical: 0 },
  eyeBtn: { paddingLeft: Spacing.sm, paddingVertical: 4 },
  forgotBtn: { alignSelf: 'flex-end', marginTop: Spacing.sm },
  forgotText: { fontSize: FontSize.sm, color: Colors.primary, fontWeight: '500' },
  primaryBtn: {
    backgroundColor: Colors.green, borderRadius: Radius.lg,
    padding: Spacing.md + 2, alignItems: 'center', marginTop: Spacing.xl,
    ...Platform.select({
      ios: { shadowColor: Colors.primary, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.3, shadowRadius: 20 },
    }),
  },
  btnDisabled: { opacity: 0.5 },
  primaryBtnText: { color: '#FFFFFF', fontSize: FontSize.md, fontWeight: '600' },
  biometricBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.sm,
    padding: Spacing.md, marginTop: Spacing.md,
  },
  biometricText: { fontSize: FontSize.sm, color: Colors.primary, fontWeight: '500' },
});
