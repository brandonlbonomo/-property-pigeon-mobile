import React, { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import {
  View, Text, StyleSheet, ActivityIndicator, TouchableOpacity,
  Dimensions, Platform, Modal, ScrollView, Image, Animated, Easing,
} from 'react-native';
import MapView, { Marker, Region } from 'react-native-maps';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Colors, FontSize, Spacing, Radius } from '../../constants/theme';
import { apiFetch } from '../../services/api';
import { useUserStore } from '../../store/userStore';
import { fmt$ } from '../../utils/format';
import { BarChart, BarData, dismissAllChartTooltips } from '../../components/BarChart';
import { Card } from '../../components/Card';

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
  is_following: boolean;
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

// Zillow-style: compact width based on text length, not revenue
// All bubbles are small readable pills — size doesn't vary much

type MapTab = 'public' | 'following';
const TAB_W = 80; // width of each tab
const BLOB_W = TAB_W + 8;

export function NetworkMapScreen() {
  const [properties, setProperties] = useState<MapProperty[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<MapProperty | null>(null);
  const [valuation, setValuation] = useState<any>(null);
  const [valuationLoading, setValuationLoading] = useState(false);
  const [mapTab, setMapTab] = useState<MapTab>('public');
  const tabAnim = useRef(new Animated.Value(0)).current;
  const mapRef = useRef<MapView>(null);
  const profile = useUserStore(s => s.profile);
  const navigation = useNavigation<any>();
  const insets = useSafeAreaInsets();

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

  // Filter by tab: public = all, following = only followed + own
  const tabFiltered = useMemo(() => {
    if (mapTab === 'following') {
      return properties.filter(p => p.is_own || p.is_following);
    }
    return properties;
  }, [properties, mapTab]);

  const visibleProps = useMemo(() => {
    if (!region) return tabFiltered.slice(0, 50);
    const latDelta = region.latitudeDelta * 0.6;
    const lngDelta = region.longitudeDelta * 0.6;
    return tabFiltered.filter(p =>
      p.lat >= region.latitude - latDelta &&
      p.lat <= region.latitude + latDelta &&
      p.lng >= region.longitude - lngDelta &&
      p.lng <= region.longitude + lngDelta
    ).slice(0, 50);
  }, [tabFiltered, region]);

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

      {/* Close button */}
      <TouchableOpacity
        activeOpacity={0.7}
        style={[styles.closeBtn, { top: insets.top + Spacing.sm }]}
        onPress={() => navigation.goBack()}
      >
        <Ionicons name="close" size={22} color={Colors.text} />
      </TouchableOpacity>

      {/* Gooey tab toggle + count */}
      <View style={[styles.countOverlay, { top: insets.top + Spacing.sm }]}>
        <View style={styles.mapTabRow}>
          {/* Sliding blob */}
          <Animated.View style={[styles.mapTabBlob, {
            transform: [
              { translateX: tabAnim.interpolate({ inputRange: [0, 1], outputRange: [3, TAB_W + 5] }) },
              { scaleX: tabAnim.interpolate({ inputRange: [0, 0.35, 0.5, 0.65, 1], outputRange: [1, 1.03, 1.05, 1.03, 1] }) },
              { scaleY: tabAnim.interpolate({ inputRange: [0, 0.35, 0.5, 0.65, 1], outputRange: [1, 0.97, 0.96, 0.97, 1] }) },
            ],
          }]} />
          <TouchableOpacity
            activeOpacity={0.8}
            style={styles.mapTabBtn}
            onPress={() => {
              setMapTab('public');
              Animated.timing(tabAnim, { toValue: 0, duration: 550, easing: Easing.bezier(0.25, 0.1, 0.25, 1), useNativeDriver: true }).start();
            }}
          >
            <Text style={[styles.mapTabText, { color: mapTab === 'public' ? '#fff' : Colors.textDim }]}>Public</Text>
          </TouchableOpacity>
          <TouchableOpacity
            activeOpacity={0.8}
            style={styles.mapTabBtn}
            onPress={() => {
              setMapTab('following');
              Animated.timing(tabAnim, { toValue: 1, duration: 550, easing: Easing.bezier(0.25, 0.1, 0.25, 1), useNativeDriver: true }).start();
            }}
          >
            <Text style={[styles.mapTabText, { color: mapTab === 'following' ? '#fff' : Colors.textDim }]}>Following</Text>
          </TouchableOpacity>
        </View>
        <Text style={styles.countOverlayText}>
          {tabFiltered.length} properties
        </Text>
      </View>

      {/* Bottom sheet for selected property */}
      <Modal
        visible={!!selected}
        transparent
        animationType="slide"
        onRequestClose={() => setSelected(null)}
      >
        <View style={styles.sheetOverlay}>
          <TouchableOpacity activeOpacity={1} style={{ flex: 1 }} onPress={() => setSelected(null)} />
          <View style={styles.sheet}>
            <View style={styles.sheetHandle} />

            {selected && (
              <ScrollView
                showsVerticalScrollIndicator={false}
                bounces={false}
                onTouchStart={dismissAllChartTooltips}
                contentContainerStyle={{ paddingBottom: Spacing.lg }}
                nestedScrollEnabled
              >
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

                {/* Revenue + 5yr Projection Bar Chart */}
                {selected.revenue > 0 && (
                  <Card>
                    <Text style={{ fontSize: 10, fontWeight: '800', color: Colors.textDim, letterSpacing: 1, marginBottom: 2 }}>REVENUE</Text>
                    <Text style={{ fontSize: FontSize.xl, fontWeight: '800', color: Colors.green, marginBottom: Spacing.xs }}>{fmt$(selected.revenue)}</Text>
                    <Text style={{ fontSize: 10, fontWeight: '700', color: Colors.textDim, letterSpacing: 0.5, marginBottom: Spacing.xs }}>5-YEAR PROJECTED INCOME</Text>
                    <BarChart
                      bars={(() => {
                        const curYear = new Date().getFullYear();
                        const rate = valuation?.appreciation_rate ? valuation.appreciation_rate / 100 : 0.035;
                        const items = [
                          { label: String(curYear).slice(2), value: selected.revenue, isActual: true, isCurrent: true, priorValue: undefined as number | undefined, priorLabel: undefined as string | undefined },
                          ...([1,2,3,4,5].map(yr => ({
                            label: String(curYear + yr).slice(2),
                            value: Math.round(selected.revenue * Math.pow(1 + rate, yr)),
                            isActual: false,
                            isCurrent: false,
                            priorValue: Math.round(selected.revenue * Math.pow(1 + rate, yr - 1)),
                            priorLabel: `'${String(curYear + yr - 1).slice(2)}`,
                          }))),
                        ];
                        return items;
                      })()}
                      color={Colors.green}
                      height={120}
                    />
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: Spacing.sm, paddingTop: Spacing.sm, borderTopWidth: StyleSheet.hairlineWidth, borderColor: Colors.border }}>
                      <Text style={{ fontSize: FontSize.xs, fontWeight: '700', color: Colors.green }}>5-Year Total</Text>
                      <Text style={{ fontSize: FontSize.xs, fontWeight: '800', color: Colors.green }}>
                        {fmt$([1,2,3,4,5].reduce((s, yr) => s + selected.revenue * Math.pow(1 + (valuation?.appreciation_rate ? valuation.appreciation_rate / 100 : 0.035), yr), 0))}
                      </Text>
                    </View>
                  </Card>
                )}

                {/* Valuation Card */}
                {valuation?.estimate && (
                  <View style={[styles.revenueCard, { backgroundColor: Colors.glassDark, borderColor: Colors.glassBorder }]}>
                    <Text style={[styles.revenueLabel, { color: Colors.text }]}>Portfolio Pigeon Estimate</Text>
                    <Text style={[styles.revenueValue, { color: Colors.green }]}>{fmt$(valuation.estimate)}</Text>

                    {/* Public metrics */}
                    {valuation.cap_rate > 0 && (
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: Spacing.sm, paddingTop: Spacing.sm, borderTopWidth: StyleSheet.hairlineWidth, borderColor: Colors.border }}>
                        <Text style={{ color: Colors.textSecondary, fontSize: FontSize.xs }}>Cap Rate</Text>
                        <Text style={{ color: Colors.text, fontSize: FontSize.xs, fontWeight: '600' }}>{valuation.cap_rate}%</Text>
                      </View>
                    )}
                    {valuation.appreciation_rate > 0 && (
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 }}>
                        <Text style={{ color: Colors.textSecondary, fontSize: FontSize.xs }}>Market Appreciation</Text>
                        <Text style={{ color: Colors.text, fontSize: FontSize.xs, fontWeight: '600' }}>{valuation.appreciation_rate}%/yr</Text>
                      </View>
                    )}
                    {valuation.years_owned > 0 && (
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 }}>
                        <Text style={{ color: Colors.textSecondary, fontSize: FontSize.xs }}>Years Owned</Text>
                        <Text style={{ color: Colors.text, fontSize: FontSize.xs, fontWeight: '600' }}>{valuation.years_owned} yrs</Text>
                      </View>
                    )}
                    {valuation.annual_revenue > 0 && (
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 }}>
                        <Text style={{ color: Colors.textSecondary, fontSize: FontSize.xs }}>Annual Revenue</Text>
                        <Text style={{ color: Colors.green, fontSize: FontSize.xs, fontWeight: '600' }}>{fmt$(valuation.annual_revenue)}</Text>
                      </View>
                    )}

                    {/* Owner-only financials */}
                    {valuation.is_own && valuation.annual_expenses > 0 && (
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 }}>
                        <Text style={{ color: Colors.textSecondary, fontSize: FontSize.xs }}>Annual Expenses</Text>
                        <Text style={{ color: Colors.red, fontSize: FontSize.xs, fontWeight: '600' }}>{fmt$(valuation.annual_expenses)}</Text>
                      </View>
                    )}
                    {valuation.is_own && valuation.noi > 0 && (
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 }}>
                        <Text style={{ color: Colors.textSecondary, fontSize: FontSize.xs }}>Net Operating Income</Text>
                        <Text style={{ color: Colors.text, fontSize: FontSize.xs, fontWeight: '700' }}>{fmt$(valuation.noi)}</Text>
                      </View>
                    )}

                    {/* Equity gain — owner only */}
                    {valuation.is_own && valuation.equity_gain != null && (
                      <View style={{ marginTop: Spacing.sm, paddingTop: Spacing.sm, borderTopWidth: StyleSheet.hairlineWidth, borderColor: Colors.border }}>
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                          <Text style={{ color: Colors.green, fontSize: FontSize.md, fontWeight: '700' }}>Equity Gain</Text>
                          <Text style={{ color: Colors.green, fontSize: FontSize.md, fontWeight: '800' }}>
                            {valuation.equity_gain >= 0 ? '+' : ''}{fmt$(valuation.equity_gain)}
                          </Text>
                        </View>
                        {valuation.purchase_price > 0 && (
                          <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 }}>
                            <Text style={{ color: Colors.textSecondary, fontSize: FontSize.xs }}>Purchase Price</Text>
                            <Text style={{ color: Colors.text, fontSize: FontSize.xs, fontWeight: '600' }}>{fmt$(valuation.purchase_price)}</Text>
                          </View>
                        )}
                      </View>
                    )}

                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: Spacing.sm }}>
                      <Ionicons name="information-circle-outline" size={12} color={Colors.textDim} />
                      <Text style={{ color: Colors.textDim, fontSize: 10, flex: 1 }}>
                        Portfolio Pigeon Proprietary Estimate. Not an appraisal.
                      </Text>
                    </View>
                  </View>
                )}
                {valuationLoading && (
                  <ActivityIndicator color={Colors.green} style={{ marginBottom: Spacing.md }} />
                )}

                {/* Quarterly Revenue Chart */}
                {valuation?.quarterly_revenue && Object.keys(valuation.quarterly_revenue).length > 0 && (
                  <Card>
                    <Text style={{ fontSize: 10, fontWeight: '800', color: Colors.textDim, letterSpacing: 1, marginBottom: Spacing.sm }}>QUARTERLY REVENUE</Text>
                    <BarChart
                      bars={(() => {
                        const entries = Object.entries(valuation.quarterly_revenue);
                        const rate = valuation?.appreciation_rate ? valuation.appreciation_rate / 100 : 0.035;
                        const qRate = Math.pow(1 + rate, 0.25) - 1; // quarterly growth rate
                        const now = new Date();
                        const curQ = Math.ceil((now.getMonth() + 1) / 3);
                        const curYear = now.getFullYear();
                        const curQKey = `${curYear}-Q${curQ}`;

                        // Actual quarters
                        const actual: BarData[] = entries.map(([qkey, val]: [string, any], i: number) => ({
                          label: qkey.replace(/^\d{4}-/, ''),
                          value: val,
                          isActual: true,
                          isCurrent: qkey === curQKey,
                          priorValue: i > 0 ? (entries[i - 1][1] as number) : undefined,
                          priorLabel: i > 0 ? (entries[i - 1][0] as string).replace(/^\d{4}-/, '') : undefined,
                        }));

                        // Project 4 future quarters from last actual
                        const lastVal = entries.length > 0 ? (entries[entries.length - 1][1] as number) : 0;
                        const lastKey = entries.length > 0 ? entries[entries.length - 1][0] : `${curYear}-Q${curQ}`;
                        const lastYear = parseInt(lastKey.split('-')[0]);
                        const lastQ = parseInt(lastKey.split('Q')[1]);
                        const projected: BarData[] = [];
                        for (let i = 1; i <= 4; i++) {
                          const q = ((lastQ - 1 + i) % 4) + 1;
                          const y = lastYear + Math.floor((lastQ - 1 + i) / 4);
                          const projVal = Math.round(lastVal * Math.pow(1 + qRate, i));
                          projected.push({
                            label: `Q${q}`,
                            value: projVal,
                            isActual: false,
                            isCurrent: false,
                            priorValue: i === 1 ? lastVal : Math.round(lastVal * Math.pow(1 + qRate, i - 1)),
                            priorLabel: i === 1 ? `Q${lastQ}` : `Q${((lastQ - 1 + i - 1) % 4) + 1}`,
                          });
                        }

                        return [...actual, ...projected];
                      })()}
                      color={Colors.green}
                      height={100}
                    />
                  </Card>
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
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  center: { flex: 1, backgroundColor: Colors.bg, alignItems: 'center', justifyContent: 'center' },
  loadingText: { color: Colors.textDim, fontSize: FontSize.sm, marginTop: Spacing.sm },

  // Zillow-style compact pill markers
  bubble: {
    backgroundColor: 'rgba(30,30,34,0.92)',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
    paddingHorizontal: 10,
    paddingVertical: 5,
    alignItems: 'center',
    justifyContent: 'center',
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.5,
        shadowRadius: 4,
      },
    }),
  },
  bubbleOwn: {
    backgroundColor: 'rgba(30,206,110,0.85)',
    borderColor: 'rgba(30,206,110,0.6)',
  },
  bubbleText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.3,
  },
  bubbleTextOwn: {
    color: '#fff',
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

  // Close button
  closeBtn: {
    position: 'absolute',
    left: Spacing.md,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: Colors.glass,
    borderWidth: 0.5,
    borderColor: Colors.glassBorder,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.4, shadowRadius: 6 },
    }),
  },
  // Count overlay
  countOverlay: {
    position: 'absolute',
    alignSelf: 'center',
    backgroundColor: Colors.glass,
    borderRadius: Radius.xl,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 6,
    borderWidth: 0.5,
    borderColor: Colors.glassBorder,
    alignItems: 'center',
    gap: 4,
  },
  countOverlayText: { color: Colors.textDim, fontSize: 10, fontWeight: '600' },
  mapTabRow: {
    flexDirection: 'row', width: TAB_W * 2 + 8, height: 32, borderRadius: 14,
    backgroundColor: 'rgba(0,0,0,0.04)', overflow: 'hidden',
    borderWidth: 0.5, borderColor: Colors.glassBorder,
  },
  mapTabBlob: {
    position: 'absolute', top: 2, bottom: 2, width: TAB_W, borderRadius: 12,
    backgroundColor: Colors.primary,
    ...Platform.select({
      ios: { shadowColor: Colors.primary, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.3, shadowRadius: 6 },
    }),
  },
  mapTabBtn: {
    width: TAB_W, alignItems: 'center', justifyContent: 'center', zIndex: 1,
  },
  mapTabText: { fontSize: FontSize.xs, fontWeight: '700' },

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
    maxHeight: SCREEN_H * 0.70,
    borderTopWidth: 0.5,
    borderTopColor: Colors.glassBorder,
  },
  sheetHandle: {
    width: 36,
    height: 4,
    backgroundColor: 'rgba(0,0,0,0.12)',
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
