import React, { useState, useRef, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  ActivityIndicator, ScrollView,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Colors, FontSize, Spacing, Radius } from '../constants/theme';
import { MAPS_PROXY_URL } from '../constants/api';

interface Props {
  value: string;
  onChangeText: (text: string) => void;
  onSelect: (city: string) => void;
  placeholder?: string;
}

export function CityAutocomplete({ value, onChangeText, onSelect, placeholder }: Props) {
  const [results, setResults] = useState<string[]>([]);
  const [searching, setSearching] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleChange = useCallback((text: string) => {
    onChangeText(text);
    setConfirmed(false);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (text.trim().length < 2) {
      setResults([]);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        const res = await fetch(
          `${MAPS_PROXY_URL}/api/places/cities?input=${encodeURIComponent(text.trim())}`,
          { signal: controller.signal },
        );
        clearTimeout(timeout);
        const data = await res.json();
        setResults(data.cities || []);
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 300);
  }, [onChangeText]);

  const handleSelect = useCallback((city: string) => {
    onSelect(city);
    setConfirmed(true);
    setResults([]);
  }, [onSelect]);

  return (
    <View style={styles.container}>
      <View style={styles.inputRow}>
        <TextInput
          style={styles.input}
          value={value}
          onChangeText={handleChange}
          placeholder={placeholder || 'e.g. Nashville, TN'}
          placeholderTextColor={Colors.textDim}
          autoCapitalize="words"
          autoCorrect={false}
        />
        {searching && (
          <ActivityIndicator size="small" color={Colors.textDim} style={styles.spinner} />
        )}
        {confirmed && !searching && (
          <Ionicons name="checkmark-circle" size={20} color={Colors.green} style={styles.check} />
        )}
      </View>
      {(results.length > 0 || (value.trim().length >= 2 && !searching && !confirmed)) && (
        <ScrollView style={styles.dropdown} nestedScrollEnabled keyboardShouldPersistTaps="handled">
          {results.map((city, i) => (
            <TouchableOpacity
              key={`${city}-${i}`}
              activeOpacity={0.7}
              style={[styles.row, styles.rowBorder]}
              onPress={() => handleSelect(city)}
            >
              <Ionicons name="location-outline" size={14} color={Colors.primary} />
              <Text style={styles.cityText}>{city}</Text>
              <Ionicons name="add-circle-outline" size={16} color={Colors.textDim} />
            </TouchableOpacity>
          ))}
          {/* Manual entry fallback */}
          {value.trim().length >= 2 && !results.some(c => c.toLowerCase() === value.trim().toLowerCase()) && (
            <TouchableOpacity
              activeOpacity={0.7}
              style={styles.row}
              onPress={() => handleSelect(value.trim())}
            >
              <Ionicons name="create-outline" size={14} color={Colors.textSecondary} />
              <Text style={styles.manualText}>
                Don't see your city? Enter "<Text style={{ fontWeight: '700', color: Colors.text }}>{value.trim()}</Text>"
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
  cityText: {
    flex: 1,
    fontSize: FontSize.md,
    color: Colors.text,
    fontWeight: '500',
  },
  manualText: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    flex: 1,
    lineHeight: 18,
  },
});
