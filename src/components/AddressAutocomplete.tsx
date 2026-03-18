import React, { useState, useRef, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  ActivityIndicator, ScrollView,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Colors, FontSize, Spacing, Radius } from '../constants/theme';
import { MAPS_PROXY_URL } from '../constants/api';

/** Hermes-compatible fetch with timeout (AbortSignal.timeout not supported) */
function fetchWithTimeout(url: string, ms = 10000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
}

export interface ResolvedAddress {
  address: string;
  lat: number;
  lng: number;
  city: string;
  state: string;
}

interface Prediction {
  place_id: string;
  description: string;
}

interface Props {
  value: string;
  onChangeText: (text: string) => void;
  onSelect: (resolved: ResolvedAddress) => void;
  placeholder?: string;
}

export function AddressAutocomplete({ value, onChangeText, onSelect, placeholder }: Props) {
  const [results, setResults] = useState<Prediction[]>([]);
  const [searching, setSearching] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleChange = useCallback((text: string) => {
    onChangeText(text);
    setConfirmed(false);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (text.trim().length < 3) {
      setResults([]);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetchWithTimeout(
          `${MAPS_PROXY_URL}/api/places/autocomplete?input=${encodeURIComponent(text.trim())}`,
        );
        const data = await res.json();
        setResults(data.predictions || []);
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 300);
  }, [onChangeText]);

  const handleSelect = useCallback(async (prediction: Prediction) => {
    setResults([]);
    setResolving(true);
    try {
      const res = await fetchWithTimeout(
        `${MAPS_PROXY_URL}/api/places/details?place_id=${encodeURIComponent(prediction.place_id)}`,
      );
      const data = await res.json();
      const resolved: ResolvedAddress = {
        address: prediction.description,
        lat: data.lat || 0,
        lng: data.lng || 0,
        city: data.city || '',
        state: data.state || '',
      };
      onChangeText(prediction.description);
      onSelect(resolved);
      setConfirmed(true);
    } catch {
      // Fallback: use the description as address, no lat/lng
      onChangeText(prediction.description);
      onSelect({ address: prediction.description, lat: 0, lng: 0, city: '', state: '' });
      setConfirmed(true);
    } finally {
      setResolving(false);
    }
  }, [onChangeText, onSelect]);

  const handleManualEntry = useCallback(() => {
    onSelect({ address: value.trim(), lat: 0, lng: 0, city: '', state: '' });
    setConfirmed(true);
    setResults([]);
  }, [value, onSelect]);

  return (
    <View style={styles.container}>
      <View style={styles.inputRow}>
        <TextInput
          style={styles.input}
          value={value}
          onChangeText={handleChange}
          placeholder={placeholder || 'e.g. 123 Main St, Nashville, TN'}
          placeholderTextColor={Colors.textDim}
          autoCapitalize="words"
          autoCorrect={false}
        />
        {(searching || resolving) && (
          <ActivityIndicator size="small" color={Colors.textDim} style={styles.spinner} />
        )}
        {confirmed && !searching && !resolving && (
          <Ionicons name="checkmark-circle" size={20} color={Colors.green} style={styles.check} />
        )}
      </View>
      {(results.length > 0 || (value.trim().length >= 3 && !searching && !confirmed && !resolving)) && (
        <ScrollView style={styles.dropdown} nestedScrollEnabled keyboardShouldPersistTaps="handled">
          {results.map((pred, i) => (
            <TouchableOpacity
              key={pred.place_id}
              activeOpacity={0.7}
              style={[styles.row, i < results.length - 1 && styles.rowBorder]}
              onPress={() => handleSelect(pred)}
            >
              <Ionicons name="location-outline" size={14} color={Colors.primary} />
              <Text style={styles.resultText} numberOfLines={2}>{pred.description}</Text>
            </TouchableOpacity>
          ))}
          {/* Manual entry fallback */}
          {value.trim().length >= 3 && !results.some(p => p.description.toLowerCase() === value.trim().toLowerCase()) && (
            <TouchableOpacity
              activeOpacity={0.7}
              style={styles.row}
              onPress={handleManualEntry}
            >
              <Ionicons name="create-outline" size={14} color={Colors.textSecondary} />
              <Text style={styles.manualText}>
                Use "<Text style={{ fontWeight: '700', color: Colors.text }}>{value.trim()}</Text>"
              </Text>
            </TouchableOpacity>
          )}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: Colors.glassHeavy,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.md,
    overflow: 'hidden',
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  input: {
    flex: 1,
    padding: Spacing.md,
    color: Colors.text,
    fontSize: FontSize.md,
  },
  spinner: { marginRight: 12 },
  check: { marginRight: 12 },
  dropdown: {
    borderTopWidth: 1,
    borderTopColor: Colors.glassBorder,
    maxHeight: 200,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm + 2,
  },
  rowBorder: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.glassBorder,
  },
  resultText: {
    fontSize: FontSize.md,
    color: Colors.text,
    fontWeight: '500',
    flex: 1,
  },
  manualText: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    flex: 1,
    lineHeight: 18,
  },
});
