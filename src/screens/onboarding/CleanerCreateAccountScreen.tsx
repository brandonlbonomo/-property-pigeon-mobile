import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  KeyboardAvoidingView, ScrollView, Platform, Alert, ActivityIndicator,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as SecureStore from 'expo-secure-store';
import { Colors, FontSize, Spacing, Radius } from '../../constants/theme';
import { useUserStore } from '../../store/userStore';
import { useOnboardingStore } from '../../store/onboardingStore';
import { apiFetch } from '../../services/api';

export function CleanerCreateAccountScreen({ navigation }: any) {
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [emailTaken, setEmailTaken] = useState(false);
  const [emailChecking, setEmailChecking] = useState(false);
  const emailCheckTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [usernameTaken, setUsernameTaken] = useState(false);
  const [usernameChecking, setUsernameChecking] = useState(false);
  const usernameCheckTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setProfile = useUserStore(s => s.setProfile);
  const setPendingCredentials = useOnboardingStore(s => s.setPendingCredentials);

  const isValidEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/.test(e);

  const usernameMinLength = username.trim().length >= 3;
  const usernameCharsValid = /^[a-zA-Z0-9._-]*$/.test(username.trim());
  const usernameValid = usernameMinLength && usernameCharsValid && !usernameTaken;
  const emailFormatValid = isValidEmail(email);
  const emailValid = emailFormatValid && !emailTaken;
  const passwordValid = password.length >= 8;
  const passwordsMatch = password === confirmPassword;
  const canSubmit = usernameValid && emailValid && passwordValid && passwordsMatch && !loading && !emailChecking && !usernameChecking;

  // Debounced username availability check
  useEffect(() => {
    if (usernameCheckTimer.current) clearTimeout(usernameCheckTimer.current);
    setUsernameTaken(false);
    if (!usernameMinLength || !usernameCharsValid) return;
    setUsernameChecking(true);
    usernameCheckTimer.current = setTimeout(async () => {
      try {
        const res = await apiFetch('/api/auth/check-username', {
          method: 'POST',
          body: JSON.stringify({ username: username.trim().toLowerCase() }),
        });
        setUsernameTaken(!res.available);
      } catch {
        setUsernameTaken(false);
      }
      setUsernameChecking(false);
    }, 500);
    return () => { if (usernameCheckTimer.current) clearTimeout(usernameCheckTimer.current); };
  }, [username]);

  // Debounced email availability check
  useEffect(() => {
    if (emailCheckTimer.current) clearTimeout(emailCheckTimer.current);
    setEmailTaken(false);

    if (!emailFormatValid) return;

    setEmailChecking(true);
    emailCheckTimer.current = setTimeout(async () => {
      try {
        const res = await apiFetch('/api/auth/check-email', {
          method: 'POST',
          body: JSON.stringify({ email: email.trim().toLowerCase() }),
        });
        setEmailTaken(!res.available);
      } catch {
        setEmailTaken(false);
      }
      setEmailChecking(false);
    }, 500);

    return () => { if (emailCheckTimer.current) clearTimeout(emailCheckTimer.current); };
  }, [email]);

  const handleSubmit = async () => {
    if (!usernameValid) { Alert.alert('Invalid', usernameTaken ? 'Username is already taken' : !usernameCharsValid ? 'Only letters, numbers, dots, dashes, and underscores' : 'Username must be at least 3 characters'); return; }
    if (!emailValid) { Alert.alert('Invalid', 'Enter a valid email address'); return; }
    if (!passwordValid) { Alert.alert('Invalid', 'Password must be at least 8 characters'); return; }
    if (!passwordsMatch) { Alert.alert('Mismatch', 'Passwords do not match'); return; }

    // Store credentials locally — registration happens at end of onboarding
    setPendingCredentials({
      username: username.trim(),
      email: email.trim().toLowerCase(),
      password,
      role: 'cleaner',
    });

    await setProfile({
      username: username.trim(),
      email: email.trim().toLowerCase(),
      accountType: 'cleaner',
      portfolioType: 'str',
    });

    navigation.navigate('CleanerFollowOwner');
  };

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <TouchableOpacity activeOpacity={0.7}
          style={styles.backBtn} onPress={() => navigation.goBack()}>
          <Ionicons name="chevron-back" size={20} color={Colors.primary} />
          <Text style={styles.backText}>Back</Text>
        </TouchableOpacity>

        {/* Progress: 1 of 4 */}
        <View style={styles.progress}>
          {[1, 2, 3, 4].map(s => (
            <View key={s} style={[styles.dot, s <= 1 && styles.dotActive]} />
          ))}
        </View>

        <Text style={styles.title}>Create cleaner account</Text>
        <Text style={styles.subtitle}>Set up your Portfolio Pigeon credentials</Text>

        {/* Username */}
        <Text style={styles.label}>Username</Text>
        <View style={styles.inputRow}>
          <TextInput
            style={[styles.input, styles.inputFlex, usernameTaken && styles.inputError]}
            value={username}
            onChangeText={setUsername}
            placeholder="Choose a username"
            placeholderTextColor={Colors.textDim}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            maxLength={30}
          />
          {usernameChecking ? (
            <ActivityIndicator size="small" color={Colors.textDim} style={styles.inputIcon} />
          ) : usernameTaken ? (
            <Ionicons name="close-circle" size={20} color={Colors.red} style={styles.inputIcon} />
          ) : usernameMinLength && usernameCharsValid ? (
            <Ionicons name="checkmark-circle" size={20} color={Colors.green} style={styles.inputIcon} />
          ) : null}
        </View>
        {username.length > 0 && !usernameMinLength && (
          <Text style={styles.hintText}>Must be at least 3 characters</Text>
        )}
        {username.length > 0 && usernameMinLength && !usernameCharsValid && (
          <Text style={styles.errorText}>Only letters, numbers, dots, dashes, and underscores</Text>
        )}
        {usernameTaken && (
          <Text style={styles.errorText}>This username is already taken</Text>
        )}

        {/* Email */}
        <Text style={styles.label}>Email</Text>
        <View style={styles.inputRow}>
          <TextInput
            style={[styles.input, styles.inputFlex, emailTaken && styles.inputError]}
            value={email}
            onChangeText={setEmail}
            placeholder="you@example.com"
            placeholderTextColor={Colors.textDim}
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            maxLength={254}
          />
          {emailChecking ? (
            <ActivityIndicator size="small" color={Colors.textDim} style={styles.inputIcon} />
          ) : emailTaken ? (
            <Ionicons name="close-circle" size={20} color={Colors.red} style={styles.inputIcon} />
          ) : emailFormatValid ? (
            <Ionicons name="checkmark-circle" size={20} color={Colors.green} style={styles.inputIcon} />
          ) : null}
        </View>
        {emailTaken && (
          <Text style={styles.errorText}>This email is already registered</Text>
        )}

        {/* Password */}
        <Text style={styles.label}>Password</Text>
        <View style={styles.inputRow}>
          <View style={[styles.input, styles.inputFlex, styles.passwordRow]}>
            <TextInput
              style={styles.passwordInput}
              value={password}
              onChangeText={setPassword}
              placeholder="Minimum 8 characters"
              placeholderTextColor={Colors.textDim}
              secureTextEntry={!showPassword}
              autoComplete="off"
            />
            <TouchableOpacity activeOpacity={0.7}
            onPress={() => setShowPassword(!showPassword)} style={styles.eyeBtn}>
              <Ionicons name={showPassword ? 'eye-off' : 'eye'} size={20} color={Colors.textDim} />
            </TouchableOpacity>
          </View>
          {passwordValid && (
            <Ionicons name="checkmark-circle" size={20} color={Colors.green} style={styles.inputIcon} />
          )}
        </View>
        {password.length > 0 && !passwordValid && (
          <Text style={styles.errorText}>Must be at least 8 characters</Text>
        )}

        {/* Confirm Password */}
        <Text style={styles.label}>Confirm Password</Text>
        <View style={styles.inputRow}>
          <TextInput
            style={[styles.input, styles.inputFlex]}
            value={confirmPassword}
            onChangeText={setConfirmPassword}
            placeholder="Re-enter password"
            placeholderTextColor={Colors.textDim}
            secureTextEntry={!showPassword}
            autoComplete="off"
          />
          {confirmPassword.length > 0 && passwordsMatch && passwordValid && (
            <Ionicons name="checkmark-circle" size={20} color={Colors.green} style={styles.inputIcon} />
          )}
        </View>
        {confirmPassword.length > 0 && !passwordsMatch && (
          <Text style={styles.errorText}>Passwords do not match</Text>
        )}

        <TouchableOpacity
          style={[styles.primaryBtn, !canSubmit && styles.btnDisabled]}
          onPress={handleSubmit}
          disabled={!canSubmit}
          activeOpacity={0.8}
        >
          {loading ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <Text style={styles.primaryBtnText}>Continue</Text>
          )}
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  scroll: { flexGrow: 1, padding: Spacing.lg, paddingTop: 60 },
  backBtn: { flexDirection: 'row', alignItems: 'center', gap: 2, marginBottom: Spacing.lg },
  backText: { fontSize: FontSize.md, color: Colors.primary },
  progress: { flexDirection: 'row', justifyContent: 'center', gap: Spacing.sm, marginBottom: Spacing.xl },
  dot: { width: 8, height: 8, borderRadius: Radius.pill, backgroundColor: Colors.border },
  dotActive: { backgroundColor: Colors.primary, width: 24 },
  title: { fontSize: FontSize.xl, fontWeight: '700', color: Colors.text, marginBottom: Spacing.xs },
  subtitle: { fontSize: FontSize.sm, color: Colors.textSecondary, marginBottom: Spacing.lg, lineHeight: 20 },
  label: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '500', marginBottom: Spacing.xs, marginTop: Spacing.md },
  input: {
    backgroundColor: Colors.glassHeavy, borderWidth: 1, borderColor: Colors.border,
    borderRadius: Radius.md, padding: Spacing.md, color: Colors.text, fontSize: FontSize.md,
  },
  inputRow: { flexDirection: 'row', alignItems: 'center' },
  inputFlex: { flex: 1 },
  inputError: { borderColor: Colors.red },
  inputIcon: { position: 'absolute', right: 12 },
  passwordRow: { flexDirection: 'row', alignItems: 'center', paddingRight: Spacing.xs, marginRight: 28 },
  passwordInput: { flex: 1, fontSize: FontSize.md, color: Colors.text, paddingVertical: 0 },
  eyeBtn: { paddingLeft: Spacing.sm, paddingVertical: 4 },
  hintText: { fontSize: FontSize.xs, color: Colors.textDim, marginTop: 4 },
  errorText: { fontSize: FontSize.xs, color: Colors.red, marginTop: 4 },
  primaryBtn: {
    backgroundColor: Colors.primary, borderRadius: Radius.lg,
    padding: Spacing.md + 2, alignItems: 'center', marginTop: Spacing.xl,
    ...Platform.select({
      ios: { shadowColor: Colors.primary, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.3, shadowRadius: 20 },
    }),
  },
  btnDisabled: { opacity: 0.5 },
  primaryBtnText: { color: '#FFFFFF', fontSize: FontSize.md, fontWeight: '600' },
});
