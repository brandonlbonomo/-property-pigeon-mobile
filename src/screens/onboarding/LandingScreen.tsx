import React from 'react';
import { View, Text, Image, TouchableOpacity, StyleSheet, Platform } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { Colors, FontSize, Spacing, Radius } from '../../constants/theme';

export function LandingScreen() {
  const navigation = useNavigation<any>();

  return (
    <View style={styles.container}>
      <View style={styles.hero}>
        <Image
          source={require('../../../assets/logo.png')}
          style={styles.logo}
        />
        <Text style={styles.title}>Portfolio Pigeon</Text>
        <Text style={styles.tagline}>Portfolio Analytics for Real Estate Investors</Text>
      </View>

      <View style={styles.actions}>
        <TouchableOpacity activeOpacity={0.7}
          style={styles.primaryBtn} onPress={() => navigation.navigate('CreateAccount')}>
          <Text style={styles.primaryBtnText}>Create Account</Text>
        </TouchableOpacity>
        <TouchableOpacity activeOpacity={0.7}
          style={styles.secondaryBtn} onPress={() => navigation.navigate('SignIn')}>
          <Text style={styles.secondaryBtnText}>Sign In</Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.footer}>Track revenue, occupancy, inventory and more</Text>

      <TouchableOpacity activeOpacity={0.7}
          style={styles.cleanerLink} onPress={() => navigation.navigate('CleanerCreateAccount')}>
        <Text style={styles.cleanerText}>I'm a Cleaner</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.bg,
    justifyContent: 'center',
    paddingHorizontal: Spacing.lg,
  },
  hero: {
    alignItems: 'center',
    marginBottom: Spacing.xl * 2,
  },
  logo: {
    width: 100, height: 100,
    marginBottom: Spacing.lg,
  },
  title: {
    fontSize: 32,
    fontWeight: '700',
    color: Colors.text,
    letterSpacing: -0.5,
    marginBottom: Spacing.sm,
  },
  tagline: {
    fontSize: FontSize.md,
    color: Colors.textSecondary,
    textAlign: 'center',
    lineHeight: 22,
  },
  actions: {
    gap: Spacing.sm,
    marginBottom: Spacing.xl,
  },
  primaryBtn: {
    backgroundColor: Colors.primary,
    borderRadius: Radius.xl,
    padding: Spacing.md + 2,
    alignItems: 'center',
    ...Platform.select({
      ios: { shadowColor: Colors.primary, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.3, shadowRadius: 20 },
    }),
  },
  primaryBtnText: {
    color: '#FFFFFF',
    fontSize: FontSize.md,
    fontWeight: '600',
  },
  secondaryBtn: {
    backgroundColor: Colors.glassHeavy,
    borderRadius: Radius.xl,
    borderWidth: 0.5,
    borderColor: Colors.glassBorder,
    borderTopColor: Colors.glassHighlight,
    borderTopWidth: 1,
    padding: Spacing.md + 2,
    alignItems: 'center',
  },
  secondaryBtnText: {
    color: Colors.text,
    fontSize: FontSize.md,
    fontWeight: '500',
  },
  footer: {
    textAlign: 'center',
    fontSize: FontSize.xs,
    color: Colors.textDim,
  },
  cleanerLink: {
    alignItems: 'center',
    marginTop: Spacing.md,
    padding: Spacing.sm,
  },
  cleanerText: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    textDecorationLine: 'underline',
  },
});
