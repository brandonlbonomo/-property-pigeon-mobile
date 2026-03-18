import React, { useRef } from 'react';
import { Modal, View, StyleSheet, TouchableOpacity, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Colors, FontSize, Spacing, Radius } from '../constants/theme';

interface Props {
  visible: boolean;
  checkoutUrl: string;
  onSuccess: () => void;
  onCancel: () => void;
  isReferred?: boolean;
}

export function StripeCheckoutModal({ visible, checkoutUrl, onSuccess, onCancel, isReferred }: Props) {
  const webViewRef = useRef<WebView>(null);

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet">
      <SafeAreaView style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity activeOpacity={0.7} onPress={onCancel} style={styles.closeBtn}>
            <Ionicons name="close" size={22} color={Colors.text} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Subscribe</Text>
          <View style={{ width: 36 }} />
        </View>
        {isReferred && (
          <View style={styles.discountBanner}>
            <Ionicons name="pricetag" size={14} color="#fff" />
            <Text style={styles.discountText}>50% off applied!</Text>
          </View>
        )}
        {checkoutUrl ? (
          <WebView
            ref={webViewRef}
            source={{ uri: checkoutUrl }}
            style={styles.webview}
            onNavigationStateChange={(navState) => {
              const url = navState.url || '';
              if (url.includes('/api/billing/success')) {
                onSuccess();
              } else if (url.includes('/api/billing/cancel')) {
                onCancel();
              }
            }}
          />
        ) : null}
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
  },
  closeBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: Colors.glassDark,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    fontSize: FontSize.md,
    fontWeight: '600',
    color: Colors.text,
  },
  discountBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: Colors.green,
    paddingVertical: 8,
  },
  discountText: {
    color: '#fff',
    fontSize: FontSize.sm,
    fontWeight: '600',
  },
  webview: { flex: 1 },
});
