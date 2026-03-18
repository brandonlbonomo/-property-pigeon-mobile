import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  KeyboardAvoidingView, ScrollView, Platform, Alert, ActivityIndicator,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Colors, FontSize, Spacing, Radius } from '../../constants/theme';
import { apiFetch } from '../../services/api';

type Step = 'email' | 'code';

export function ForgotPasswordScreen({ navigation }: any) {
  const [step, setStep] = useState<Step>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);

  const isValidEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/.test(e);

  const handleSendCode = async () => {
    if (!email.trim()) {
      Alert.alert('Required', 'Enter your email address');
      return;
    }
    if (!isValidEmail(email.trim())) {
      Alert.alert('Invalid', 'Enter a valid email address');
      return;
    }

    setLoading(true);
    try {
      await apiFetch('/api/auth/forgot-password', {
        method: 'POST',
        body: JSON.stringify({ email: email.trim().toLowerCase() }),
      });
      setStep('code');
      Alert.alert('Code Sent', 'Check your email for a 6-digit reset code.');
    } catch (err: any) {
      Alert.alert('Error', err.serverError || err.message || 'Could not send reset code');
    } finally {
      setLoading(false);
    }
  };

  const handleResetPassword = async () => {
    if (!code.trim()) {
      Alert.alert('Required', 'Enter the 6-digit code from your email');
      return;
    }
    if (!newPassword || newPassword.length < 8) {
      Alert.alert('Required', 'Password must be at least 8 characters');
      return;
    }

    setLoading(true);
    try {
      await apiFetch('/api/auth/reset-password', {
        method: 'POST',
        body: JSON.stringify({
          email: email.trim().toLowerCase(),
          code: code.trim(),
          new_password: newPassword,
        }),
      });
      Alert.alert('Password Reset', 'Your password has been updated. Sign in with your new password.', [
        { text: 'Sign In', onPress: () => navigation.goBack() },
      ]);
    } catch (err: any) {
      Alert.alert('Error', err.serverError || err.message || 'Could not reset password');
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <TouchableOpacity activeOpacity={0.7}
          style={styles.backBtn} onPress={() => navigation.goBack()}>
          <Ionicons name="chevron-back" size={20} color={Colors.primary} />
          <Text style={styles.backText}>Back</Text>
        </TouchableOpacity>

        <View style={styles.hero}>
          <View style={styles.iconCircle}>
            <Ionicons name={step === 'email' ? 'mail-outline' : 'key-outline'} size={32} color={Colors.primary} />
          </View>
          <Text style={styles.title}>
            {step === 'email' ? 'Forgot Password?' : 'Enter Reset Code'}
          </Text>
          <Text style={styles.subtitle}>
            {step === 'email'
              ? "Enter your email and we'll send you a code to reset your password."
              : `We sent a 6-digit code to ${email}. Enter it below with your new password.`}
          </Text>
        </View>

        {step === 'email' ? (
          <>
            <Text style={styles.label}>Email</Text>
            <TextInput
              style={styles.input}
              value={email}
              onChangeText={setEmail}
              placeholder="Enter your email"
              placeholderTextColor={Colors.textDim}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
            />

            <TouchableOpacity
              style={[styles.primaryBtn, (!email.trim() || loading) && styles.btnDisabled]}
              onPress={handleSendCode}
              disabled={!email.trim() || loading}
              activeOpacity={0.8}
            >
              {loading ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <Text style={styles.primaryBtnText}>Send Reset Code</Text>
              )}
            </TouchableOpacity>
          </>
        ) : (
          <>
            <Text style={styles.label}>Reset Code</Text>
            <TextInput
              style={[styles.input, styles.codeInput]}
              value={code}
              onChangeText={setCode}
              placeholder="000000"
              placeholderTextColor={Colors.textDim}
              keyboardType="number-pad"
              maxLength={6}
              autoFocus
            />

            <Text style={styles.label}>New Password</Text>
            <View style={[styles.input, styles.passwordRow]}>
              <TextInput
                style={styles.passwordInput}
                value={newPassword}
                onChangeText={setNewPassword}
                placeholder="At least 8 characters"
                placeholderTextColor={Colors.textDim}
                secureTextEntry={!showPassword}
              />
              <TouchableOpacity activeOpacity={0.7}
          onPress={() => setShowPassword(!showPassword)} style={styles.eyeBtn}>
                <Ionicons name={showPassword ? 'eye-off' : 'eye'} size={20} color={Colors.textDim} />
              </TouchableOpacity>
            </View>

            <TouchableOpacity
              style={[styles.primaryBtn, (!code.trim() || !newPassword || loading) && styles.btnDisabled]}
              onPress={handleResetPassword}
              disabled={!code.trim() || !newPassword || loading}
              activeOpacity={0.8}
            >
              {loading ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <Text style={styles.primaryBtnText}>Reset Password</Text>
              )}
            </TouchableOpacity>

            <TouchableOpacity activeOpacity={0.7}
          style={styles.resendBtn} onPress={handleSendCode} disabled={loading}>
              <Text style={styles.resendText}>Didn't get the code? Resend</Text>
            </TouchableOpacity>
          </>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  scroll: { flexGrow: 1, padding: Spacing.lg, paddingTop: 60, justifyContent: 'center' },
  backBtn: { flexDirection: 'row', alignItems: 'center', gap: 2, marginBottom: Spacing.lg },
  backText: { fontSize: FontSize.md, color: Colors.primary },
  hero: { alignItems: 'center', marginBottom: Spacing.xl },
  iconCircle: {
    width: 70, height: 70, borderRadius: 35,
    backgroundColor: Colors.greenDim,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: Spacing.md,
  },
  title: { fontSize: FontSize.xl, fontWeight: '700', color: Colors.text, marginBottom: Spacing.xs },
  subtitle: { fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center', lineHeight: 20 },
  label: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '500', marginBottom: Spacing.xs, marginTop: Spacing.md },
  input: {
    backgroundColor: Colors.glassHeavy, borderWidth: 1, borderColor: Colors.border,
    borderRadius: Radius.md, padding: Spacing.md, color: Colors.text, fontSize: FontSize.md,
  },
  codeInput: { fontSize: 24, fontWeight: '700', letterSpacing: 8, textAlign: 'center' },
  inputRow: { flexDirection: 'row', alignItems: 'center' },
  eyeIcon: { position: 'absolute', right: 12 },
  passwordRow: { flexDirection: 'row', alignItems: 'center', paddingRight: Spacing.xs },
  passwordInput: { flex: 1, fontSize: FontSize.md, color: Colors.text, paddingVertical: 0 },
  eyeBtn: { paddingLeft: Spacing.sm, paddingVertical: 4 },
  primaryBtn: {
    backgroundColor: Colors.green, borderRadius: Radius.lg,
    padding: Spacing.md + 2, alignItems: 'center', marginTop: Spacing.xl,
    ...Platform.select({
      ios: { shadowColor: Colors.primary, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.3, shadowRadius: 20 },
    }),
  },
  btnDisabled: { opacity: 0.5 },
  primaryBtnText: { color: '#FFFFFF', fontSize: FontSize.md, fontWeight: '600' },
  resendBtn: { alignItems: 'center', padding: Spacing.md, marginTop: Spacing.sm },
  resendText: { fontSize: FontSize.sm, color: Colors.primary, fontWeight: '500' },
});
