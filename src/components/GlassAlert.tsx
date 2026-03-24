import React, { useEffect, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Modal,
  Animated, Platform, Dimensions,
} from 'react-native';
import { Colors, FontSize, Spacing, Radius } from '../constants/theme';

const { width: SCREEN_W } = Dimensions.get('window');

interface AlertButton {
  text: string;
  style?: 'default' | 'cancel' | 'destructive';
  onPress?: () => void;
}

interface AlertState {
  visible: boolean;
  title: string;
  message?: string;
  buttons: AlertButton[];
}

// ── Global imperative API ──
let _setAlert: ((state: AlertState) => void) | null = null;

export function glassAlert(
  title: string,
  message?: string,
  buttons?: AlertButton[],
) {
  const btns = buttons || [{ text: 'OK' }];
  if (_setAlert) {
    _setAlert({ visible: true, title, message, buttons: btns });
  } else {
    // Fallback if provider not mounted yet
    const { Alert } = require('react-native');
    Alert.alert(title, message || undefined, btns);
  }
}

// Drop-in replacement for Alert.alert
export const GlassAlertAPI = {
  alert: glassAlert,
};

export function GlassAlertProvider() {
  const [state, setState] = React.useState<AlertState>({
    visible: false,
    title: '',
    message: undefined,
    buttons: [],
  });

  useEffect(() => {
    _setAlert = setState;
    // Never null out — provider is at root level and should persist
  }, []);

  const fadeAnim = useRef(new Animated.Value(0)).current;
  const scaleAnim = useRef(new Animated.Value(0.85)).current;

  useEffect(() => {
    if (state.visible) {
      fadeAnim.setValue(0);
      scaleAnim.setValue(0.85);
      Animated.parallel([
        Animated.timing(fadeAnim, { toValue: 1, duration: 200, useNativeDriver: true }),
        Animated.spring(scaleAnim, { toValue: 1, tension: 80, friction: 10, useNativeDriver: true }),
      ]).start();
    }
  }, [state.visible]);

  const dismiss = (btn?: AlertButton) => {
    Animated.parallel([
      Animated.timing(fadeAnim, { toValue: 0, duration: 150, useNativeDriver: true }),
      Animated.timing(scaleAnim, { toValue: 0.9, duration: 150, useNativeDriver: true }),
    ]).start(() => {
      setState(s => ({ ...s, visible: false }));
      btn?.onPress?.();
    });
  };

  if (!state.visible) return null;

  const hasCancel = state.buttons.some(b => b.style === 'cancel');
  const actionButtons = state.buttons.filter(b => b.style !== 'cancel');
  const cancelButton = state.buttons.find(b => b.style === 'cancel');

  return (
    <Modal transparent visible animationType="none" statusBarTranslucent>
      <Animated.View style={[styles.overlay, { opacity: fadeAnim }]}>
        <Animated.View style={[styles.card, { transform: [{ scale: scaleAnim }] }]}>
          {/* Glass shine */}
          <View style={styles.shine} />

          <Text style={styles.title}>{state.title}</Text>
          {state.message ? (
            <Text style={styles.message}>{state.message}</Text>
          ) : null}

          <View style={styles.buttonRow}>
            {hasCancel && cancelButton && (
              <TouchableOpacity
                activeOpacity={0.6}
                style={styles.btnCancel}
                onPress={() => dismiss(cancelButton)}
              >
                <Text style={styles.btnCancelText}>{cancelButton.text}</Text>
              </TouchableOpacity>
            )}
            {actionButtons.map((btn, i) => (
              <TouchableOpacity
                key={i}
                activeOpacity={0.6}
                style={[
                  styles.btnAction,
                  btn.style === 'destructive' && styles.btnDestructive,
                  actionButtons.length === 1 && !hasCancel && { flex: 1 },
                ]}
                onPress={() => dismiss(btn)}
              >
                <Text style={[
                  styles.btnActionText,
                  btn.style === 'destructive' && styles.btnDestructiveText,
                ]}>
                  {btn.text}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </Animated.View>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.25)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.xl,
  },
  card: {
    width: Math.min(SCREEN_W - Spacing.xl * 2, 320),
    backgroundColor: Colors.glassOverlay,
    borderRadius: Radius.xl,
    borderWidth: 0.5,
    borderColor: Colors.glassBorder,
    borderTopColor: Colors.glassHighlight,
    borderTopWidth: 1,
    padding: Spacing.lg,
    overflow: 'hidden',
    ...Platform.select({
      ios: {
        shadowColor: 'rgba(0,0,0,0.15)',
        shadowOffset: { width: 0, height: 12 },
        shadowOpacity: 1,
        shadowRadius: 30,
      },
      android: { elevation: 20 },
    }),
  },
  shine: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: '40%',
    backgroundColor: 'rgba(255,255,255,0.3)',
    borderTopLeftRadius: Radius.xl,
    borderTopRightRadius: Radius.xl,
  },
  title: {
    fontSize: FontSize.lg,
    fontWeight: '700',
    color: Colors.text,
    textAlign: 'center',
    marginBottom: Spacing.xs,
    zIndex: 1,
  },
  message: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: Spacing.lg,
    zIndex: 1,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: Spacing.sm,
    zIndex: 1,
  },
  btnCancel: {
    flex: 1,
    paddingVertical: Spacing.sm + 2,
    borderRadius: Radius.lg,
    backgroundColor: Colors.glassDark,
    borderWidth: 0.5,
    borderColor: Colors.glassBorder,
    alignItems: 'center',
  },
  btnCancelText: {
    fontSize: FontSize.sm,
    fontWeight: '600',
    color: Colors.textSecondary,
  },
  btnAction: {
    flex: 1,
    paddingVertical: Spacing.sm + 2,
    borderRadius: Radius.lg,
    backgroundColor: Colors.green,
    alignItems: 'center',
    ...Platform.select({
      ios: {
        shadowColor: Colors.green,
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.3,
        shadowRadius: 8,
      },
    }),
  },
  btnActionText: {
    fontSize: FontSize.sm,
    fontWeight: '700',
    color: '#fff',
  },
  btnDestructive: {
    backgroundColor: Colors.red,
    ...Platform.select({
      ios: {
        shadowColor: Colors.red,
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.3,
        shadowRadius: 8,
      },
    }),
  },
  btnDestructiveText: {
    color: '#fff',
  },
});
