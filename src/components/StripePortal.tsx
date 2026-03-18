import React, { useRef } from 'react';
import { Modal, View, StyleSheet, TouchableOpacity, Text, SafeAreaView } from 'react-native';
import { WebView } from 'react-native-webview';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Colors, FontSize, Spacing } from '../constants/theme';

interface Props {
  visible: boolean;
  portalUrl: string;
  onClose: () => void;
}

export function StripePortalModal({ visible, portalUrl, onClose }: Props) {
  const webViewRef = useRef<WebView>(null);

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet">
      <SafeAreaView style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity activeOpacity={0.7} onPress={onClose} style={styles.closeBtn}>
            <Ionicons name="close" size={22} color={Colors.text} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Manage Subscription</Text>
          <View style={{ width: 36 }} />
        </View>
        {portalUrl ? (
          <WebView
            ref={webViewRef}
            source={{ uri: portalUrl }}
            style={styles.webview}
            onNavigationStateChange={(navState) => {
              const url = navState.url || '';
              if (url.includes('/api/billing/portal-return')) {
                onClose();
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
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
  },
  closeBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(170,180,200,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: Colors.text,
  },
  webview: { flex: 1 },
});
