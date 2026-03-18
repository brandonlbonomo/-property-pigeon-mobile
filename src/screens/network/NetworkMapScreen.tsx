import React, { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import {
  View, Text, StyleSheet, ActivityIndicator, TouchableOpacity,
  Dimensions, Platform, Modal, ScrollView, Image,
} from 'react-native';
import MapView, { Marker, Region } from 'react-native-maps';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Colors, FontSize, Spacing, Radius } from '../../constants/theme';
import { apiFetch } from '../../services/api';
import { useUserStore } from '../../store/userStore';
import { fmt$ } from '../../utils/format';

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

interface MapProperty {
  id: string;
  lat: number;
  lng: number;
  label: string;
  address: string;
  units: number;
  isAirbnb: boolean;
  market: string;
  revenue: number;
  owner_id: string;
  owner_username: string;
  is_own: boolean;
  photos: string[];
}

// Muted dark map style
const MAP_STYLE = [
  { elementType: 'geometry', stylers: [{ color: '#1d1d1d' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#757575' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#212121' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#2c2c2c' }] },
  { featureType: 'road', elementType: 'labels.text.fill', stylers: [{ color: '#515151' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#0e0e0e' }] },
  { featureType: 'poi', stylers: [{ visibility: 'off' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
];

function formatRevenue(rev: number): string {
  if (rev >= 1_000_000) return `$${(rev / 1_000_000).toFixed(1)}M`;
  if (rev >= 1_000) return `$${Math.round(rev / 1_000)}K`;
  return fmt$(rev);
}

function bubbleSize(rev: number): number {
  const min = 50, max = 90;
  if (rev <= 0) return min;
  const scale = Math.log10(Math.max(rev, 1)) / 6; // log scale, 6 = $1M
  return Math.min(max, Math.max(min, min + (max - min) * scale));
}

export function NetworkMapScreen() {
  const [properties, setProperties] = useState<MapProperty[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<MapProperty | null>(null);
  const [valuation, setValuation] = useState<any>(null);
  const [valuationLoading, setValuationLoading] = useState(false);
  const mapRef = useRef<MapView>(null);
  const profile = useUserStore(s => s.profile);

  // Fetch valuation when a property is selected (own properties only)
  useEffect(() => {
    if (!selected?.is_own) { setValuation(null); return; }
    setValuationLoading(true);
    apiFetch(`/api/properties/${encodeURIComponent(selected.id)}/valuation`)
      .then(res => setValuation(res.valuation || null))
      .catch(() => setValuation(null))
      .finally(() => setValuationLoading(false));
  }, [selected?.id]);

  const loadProperties = useCallback(async () => {
    try {
      const res = await apiFetch('/api/map/properties');
      setProperties(res.properties || []);
    } catch {
      setProperties([]);
    }
    setLoading(false);
  }, []);

  useEffect(() => { loadProperties(); }, []);

  // Fit camera to user's properties on first load
  useEffect(() => {
    if (properties.length === 0 || !mapRef.current) return;
    const ownProps = properties.filter(p => p.is_own);
    const toFit = ownProps.length > 0 ? ownProps : properties.slice(0, 10);
    if (toFit.length === 0) return;

    const coords = toFit.map(p => ({ latitude: p.lat, longitude: p.lng }));
    setTimeout(() => {
      mapRef.current?.fitToCoordinates(coords, {
        edgePadding: { top: 100, right: 60, bottom: 200, left: 60 },
        animated: true,
      });
    }, 500);
  }, [properties]);

  // Cluster nearby properties when zoomed out
  const [region, setRegion] = useState<Region | null>(null);

  const visibleProps = useMemo(() => {
    if (!region) return properties.slice(0, 50);
    // Filter to viewport + buffer
    const latDelta = region.latitudeDelta * 0.6;
    const lngDelta = region.longitudeDelta * 0.6;
    return properties.filter(p =>
      p.lat >= region.latitude - latDelta &&
      p.lat <= region.latitude + latDelta &&
      p.lng >= region.longitude - lngDelta &&
      p.lng <= region.longitude + lngDelta
    ).slice(0, 50);
  }, [properties, region]);

  const clusters = useMemo(() => {
    if (!region || region.latitudeDelta < 0.5) return visibleProps.map(p => ({ ...p, cluster: false, count: 1 }));

    // Simple grid-based clustering
    const cellSize = region.latitudeDelta / 8;
    const grid: Record<string, { props: MapProperty[]; lat: number; lng: number; revenue: number }> = {};

    for (const p of visibleProps) {
      const key = `${Math.floor(p.lat / cellSize)},${Math.floor(p.lng / cellSize)}`;
      if (!grid[key]) grid[key] = { props: [], lat: 0, lng: 0, revenue: 0 };
      grid[key].props.push(p);
      grid[key].lat += p.lat;
      grid[key].lng += p.lng;
      grid[key].revenue += p.revenue;
    }

    return Object.values(grid).map(g => ({
      id: g.props[0].id,
      lat: g.lat / g.props.length,
      lng: g.lng / g.props.length,
      revenue: g.revenue,
      label: g.props.length > 1 ? `${g.props.length} properties` : g.props[0].label,
      is_own: g.props.some(p => p.is_own),
      cluster: g.props.length > 1,
      count: g.props.length,
      props: g.props,
      // Pass through for single items
      ...(g.props.length === 1 ? g.props[0] : {}),
    }));
  }, [visibleProps, region]);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={Colors.green} />
        <Text style={styles.loadingText}>Loading network...</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <MapView
        ref={mapRef}
        style={StyleSheet.absoluteFillObject}
        customMapStyle={MAP_STYLE}
        showsUserLocation
        showsMyLocationButton={false}
        showsCompass={false}
        onRegionChangeComplete={setRegion}
        initialRegion={{
          latitude: 37.7749,
          longitude: -95.7129,
          latitudeDelta: 40,
          longitudeDelta: 40,
        }}
      >
        {clusters.map((item: any, i: number) => (
          <Marker
            key={item.id + i}
            coordinate={{ latitude: item.lat, longitude: item.lng }}
            onPress={() => {
              if (item.cluster) {
                // Zoom into cluster
                mapRef.current?.animateToRegion({
                  latitude: item.lat,
                  longitude: item.lng,
                  latitudeDelta: (region?.latitudeDelta || 10) / 4,
                  longitudeDelta: (region?.longitudeDelta || 10) / 4,
                }, 400);
              } else {
                setSelected(item);
              }
            }}
          >
            <View style={[
              styles.bubble,
              { width: bubbleSize(item.revenue), height: bubbleSize(item.revenue) * 0.55 },
              item.is_own && styles.bubbleOwn,
            ]}>
              <Text style={[styles.bubbleText, item.is_own && styles.bubbleTextOwn]} numberOfLines={1}>
                {formatRevenue(item.revenue)}
              </Text>
              {item.cluster && (
                <View style={styles.countBadge}>
                  <Text style={styles.countText}>{item.count}</Text>
                </View>
              )}
            </View>
          </Marker>
        ))}
      </MapView>

      {/* Property count overlay */}
      <View style={styles.countOverlay}>
        <Text style={styles.countOverlayText}>
          {properties.length} properties
        </Text>
      </View>

      {/* Bottom sheet for selected property */}
      <Modal
        visible={!!selected}
        transparent
        animationType="slide"
        onRequestClose={() => setSelected(null)}
      >
        <TouchableOpacity
          activeOpacity={1}
          style={styles.sheetOverlay}
          onPress={() => setSelected(null)}
        >
          <View style={styles.sheet} onStartShouldSetResponder={() => true}>
            <View style={styles.sheetHandle} />

            {selected && (
              <ScrollView showsVerticalScrollIndicator={false}>
                {/* Photo */}
                {selected.photos?.[0] && (
                  <Image source={{ uri: selected.photos[0] }} style={styles.sheetPhoto} />
                )}

                {/* Property info */}
                <Text style={styles.sheetName}>{selected.label}</Text>
                {selected.address ? (
                  <Text style={styles.sheetAddress}>{selected.address}</Text>
                ) : null}

                <View style={styles.sheetRow}>
                  <View style={styles.sheetChip}>
                    <Ionicons name={selected.isAirbnb ? 'bed-outline' : 'business-outline'} size={14} color={Colors.green} />
                    <Text style={styles.sheetChipText}>
                      {selected.isAirbnb ? 'STR' : 'LTR'} · {selected.units} unit{selected.units !== 1 ? 's' : ''}
                    </Text>
                  </View>
                  {selected.market ? (
                    <View style={styles.sheetChip}>
                      <Ionicons name="location-outline" size={14} color={Colors.textSecondary} />
                      <Text style={styles.sheetChipText}>{selected.market}</Text>
                    </View>
                  ) : null}
                </View>

                {/* Revenue */}
                <View style={styles.revenueCard}>
                  <Text style={styles.revenueLabel}>Annual Revenue</Text>
                  <Text style={styles.revenueValue}>{fmt$(selected.revenue)}</Text>
                </View>

                {/* Valuation breakdown (own properties only) */}
                {selected.is_own && valuation && (
                  <View style={[styles.revenueCard, { backgroundColor: Colors.glassDark, borderColor: Colors.glassBorder }]}>
                    <Text style={[styles.revenueLabel, { color: Colors.text }]}>Portfolio Pigeon Estimate</Text>
                    <Text style={[styles.revenueValue, { color: Colors.green }]}>{fmt$(valuation.blended_estimate)}</Text>

                    <View style={{ marginTop: Spacing.sm, gap: 6 }}>
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                        <Text style={{ color: Colors.textSecondary, fontSize: FontSize.xs }}>Purchase Price</Text>
                        <Text style={{ color: Colors.text, fontSize: FontSize.xs, fontWeight: '600' }}>{fmt$(valuation.purchase_price)}</Text>
                      </View>
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                        <Text style={{ color: Colors.textSecondary, fontSize: FontSize.xs }}>Years Owned</Text>
                        <Text style={{ color: Colors.text, fontSize: FontSize.xs, fontWeight: '600' }}>{valuation.years_owned} yrs</Text>
                      </View>
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                        <Text style={{ color: Colors.textSecondary, fontSize: FontSize.xs }}>Appreciation ({valuation.appreciation_rate}%/yr)</Text>
                        <Text style={{ color: Colors.green, fontSize: FontSize.xs, fontWeight: '600' }}>+{fmt$(valuation.appreciation_gain)} ({valuation.appreciation_pct}%)</Text>
                      </View>
                      {valuation.annual_revenue > 0 && (
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                          <Text style={{ color: Colors.textSecondary, fontSize: FontSize.xs }}>Revenue Value ({valuation.grm}x GRM)</Text>
                          <Text style={{ color: Colors.text, fontSize: FontSize.xs, fontWeight: '600' }}>{fmt$(valuation.revenue_value)}</Text>
                        </View>
                      )}
                      <View style={{ height: 1, backgroundColor: Colors.border, marginVertical: 4 }} />
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                        <Text style={{ color: Colors.green, fontSize: FontSize.md, fontWeight: '700' }}>Equity Gain</Text>
                        <Text style={{ color: Colors.green, fontSize: FontSize.md, fontWeight: '800' }}>+{fmt$(valuation.equity_gain)}</Text>
                      </View>
                    </View>

                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: Spacing.sm }}>
                      <Ionicons name="information-circle-outline" size={12} color={Colors.textDim} />
                      <Text style={{ color: Colors.textDim, fontSize: 10, flex: 1 }}>
                        Based on purchase price, time owned, and revenue. Not an appraisal.
                      </Text>
                    </View>
                  </View>
                )}
                {selected.is_own && valuationLoading && (
                  <ActivityIndicator color={Colors.green} style={{ marginBottom: Spacing.md }} />
                )}

                {/* Owner */}
                <View style={styles.ownerRow}>
                  <View style={styles.avatar}>
                    <Ionicons name="person" size={18} color={Colors.textDim} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.ownerName}>
                      @{selected.owner_username || 'user'}
                    </Text>
                  </View>
                  {selected.is_own ? (
                    <View style={[styles.actionBtn, { backgroundColor: Colors.glassDark }]}>
                      <Text style={[styles.actionText, { color: Colors.textSecondary }]}>Your Property</Text>
                    </View>
                  ) : (
                    <TouchableOpacity activeOpacity={0.7} style={styles.actionBtn}>
                      <Ionicons name="person-add-outline" size={14} color="#fff" />
                      <Text style={styles.actionText}>Follow</Text>
                    </TouchableOpacity>
                  )}
                </View>
              </ScrollView>
            )}
          </View>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  center: { flex: 1, backgroundColor: Colors.bg, alignItems: 'center', justifyContent: 'center' },
  loadingText: { color: Colors.textDim, fontSize: FontSize.sm, marginTop: Spacing.sm },

  // Bubble markers
  bubble: {
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderRadius: Radius.pill,
    borderWidth: 0.5,
    borderColor: 'rgba(255,255,255,0.25)',
    alignItems: 'center',
    justifyContent: 'center',
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.3,
        shadowRadius: 8,
      },
    }),
  },
  bubbleOwn: {
    backgroundColor: 'rgba(30,206,110,0.2)',
    borderColor: 'rgba(30,206,110,0.5)',
  },
  bubbleText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
    textShadowColor: 'rgba(0,0,0,0.5)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
  },
  bubbleTextOwn: {
    color: Colors.green,
  },
  countBadge: {
    position: 'absolute',
    top: -6,
    right: -6,
    backgroundColor: Colors.green,
    borderRadius: 10,
    width: 20,
    height: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  countText: { color: '#fff', fontSize: 10, fontWeight: '700' },

  // Count overlay
  countOverlay: {
    position: 'absolute',
    top: Spacing.md,
    alignSelf: 'center',
    backgroundColor: Colors.glass,
    borderRadius: Radius.pill,
    paddingHorizontal: Spacing.md,
    paddingVertical: 6,
    borderWidth: 0.5,
    borderColor: Colors.glassBorder,
  },
  countOverlayText: { color: Colors.text, fontSize: FontSize.xs, fontWeight: '600' },

  // Bottom sheet
  sheetOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: Colors.bg,
    borderTopLeftRadius: Radius.lg,
    borderTopRightRadius: Radius.lg,
    padding: Spacing.md,
    maxHeight: SCREEN_H * 0.55,
    borderTopWidth: 0.5,
    borderTopColor: Colors.glassBorder,
  },
  sheetHandle: {
    width: 36,
    height: 4,
    backgroundColor: 'rgba(255,255,255,0.15)',
    borderRadius: 2,
    alignSelf: 'center',
    marginBottom: Spacing.md,
  },
  sheetPhoto: {
    width: '100%',
    height: 140,
    borderRadius: Radius.md,
    marginBottom: Spacing.md,
    backgroundColor: Colors.glassDark,
  },
  sheetName: {
    fontSize: FontSize.xl,
    fontWeight: '700',
    color: Colors.text,
    marginBottom: 4,
  },
  sheetAddress: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    marginBottom: Spacing.sm,
  },
  sheetRow: {
    flexDirection: 'row',
    gap: Spacing.sm,
    marginBottom: Spacing.md,
  },
  sheetChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: Colors.glassDark,
    borderRadius: Radius.pill,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 4,
    borderWidth: 0.5,
    borderColor: Colors.glassBorder,
  },
  sheetChipText: {
    fontSize: FontSize.xs,
    color: Colors.textSecondary,
  },
  revenueCard: {
    backgroundColor: Colors.greenDim,
    borderRadius: Radius.md,
    padding: Spacing.md,
    marginBottom: Spacing.md,
    borderWidth: 0.5,
    borderColor: Colors.green + '30',
  },
  revenueLabel: {
    fontSize: FontSize.xs,
    color: Colors.green,
    fontWeight: '500',
    marginBottom: 2,
  },
  revenueValue: {
    fontSize: FontSize.xl,
    fontWeight: '800',
    color: Colors.green,
  },
  ownerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    marginBottom: Spacing.md,
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: Colors.glassDark,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 0.5,
    borderColor: Colors.glassBorder,
  },
  ownerName: {
    fontSize: FontSize.md,
    fontWeight: '600',
    color: Colors.text,
  },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: Colors.green,
    borderRadius: Radius.pill,
    paddingHorizontal: Spacing.md,
    paddingVertical: 8,
  },
  actionText: {
    color: '#fff',
    fontSize: FontSize.xs,
    fontWeight: '600',
  },
});
