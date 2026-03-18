import React, { useState, useEffect } from 'react';
import { View, Text, Image, ActivityIndicator, StyleSheet, ViewStyle, TouchableOpacity, Modal, SafeAreaView } from 'react-native';
import { WebView } from 'react-native-webview';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Colors, FontSize, Spacing, Radius } from '../constants/theme';
import { MAPS_PROXY_URL } from '../constants/api';

function fetchWithTimeout(url: string, ms = 10000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
}

interface Props {
  lat?: number;
  lng?: number;
  height?: number;
  style?: ViewStyle;
  /** When true, tapping the image opens a full-screen interactive Street View */
  interactive?: boolean;
}

export function PropertyStreetView({ lat, lng, height = 180, style, interactive = false }: Props) {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [showInteractive, setShowInteractive] = useState(false);

  useEffect(() => {
    if (!lat || !lng) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setAvailable(null);

    (async () => {
      try {
        const res = await fetchWithTimeout(
          `${MAPS_PROXY_URL}/api/streetview/metadata?lat=${lat}&lng=${lng}`,
        );
        const data = await res.json();
        if (!cancelled) setAvailable(data.available === true);
      } catch {
        if (!cancelled) setAvailable(false);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [lat, lng]);

  if (!lat || !lng) return null;

  if (loading) {
    return (
      <View style={[styles.container, { height }, style]}>
        <ActivityIndicator size="small" color={Colors.textDim} />
      </View>
    );
  }

  if (!available) {
    return (
      <View style={[styles.container, styles.placeholder, { height }, style]}>
        <Ionicons name="image-outline" size={28} color={Colors.textDim} />
        <Text style={styles.placeholderText}>No street view available</Text>
      </View>
    );
  }

  const imageUri = `${MAPS_PROXY_URL}/api/streetview?lat=${lat}&lng=${lng}&width=600&height=300`;
  const embedUri = `${MAPS_PROXY_URL}/api/streetview/embed?lat=${lat}&lng=${lng}`;

  const imageContent = (
    <View style={[styles.container, { height }, style]}>
      <Image
        source={{ uri: imageUri }}
        style={[styles.image, { height }]}
        resizeMode="cover"
      />
      {interactive && (
        <View style={styles.expandBadge}>
          <Ionicons name="expand-outline" size={14} color="#fff" />
          <Text style={styles.expandText}>Explore</Text>
        </View>
      )}
    </View>
  );

  if (!interactive) return imageContent;

  return (
    <>
      <TouchableOpacity activeOpacity={0.8} onPress={() => setShowInteractive(true)}>
        {imageContent}
      </TouchableOpacity>

      <Modal visible={showInteractive} animationType="slide" onRequestClose={() => setShowInteractive(false)}>
        <SafeAreaView style={styles.fullscreen}>
          <View style={styles.header}>
            <TouchableOpacity activeOpacity={0.7} onPress={() => setShowInteractive(false)} style={styles.closeBtn}>
              <Ionicons name="close" size={22} color={Colors.text} />
            </TouchableOpacity>
            <Text style={styles.headerTitle}>Street View</Text>
            <View style={{ width: 36 }} />
          </View>
          <WebView
            source={{ uri: embedUri }}
            style={{ flex: 1 }}
            javaScriptEnabled
            domStorageEnabled
            startInLoadingState
            renderLoading={() => (
              <View style={styles.webviewLoading}>
                <ActivityIndicator size="large" color={Colors.green} />
              </View>
            )}
          />
        </SafeAreaView>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    borderRadius: Radius.lg,
    overflow: 'hidden',
    backgroundColor: Colors.glassDark,
    justifyContent: 'center',
    alignItems: 'center',
  },
  image: {
    width: '100%',
    borderRadius: Radius.lg,
  },
  placeholder: {
    gap: Spacing.xs,
  },
  placeholderText: {
    fontSize: FontSize.xs,
    color: Colors.textDim,
  },
  expandBadge: {
    position: 'absolute',
    bottom: Spacing.sm,
    right: Spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: Radius.pill,
  },
  expandText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
  },
  fullscreen: {
    flex: 1,
    backgroundColor: Colors.bg,
  },
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
  webviewLoading: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.bg,
  },
});
