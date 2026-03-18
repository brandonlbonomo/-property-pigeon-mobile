import React, { useState, useRef, useCallback } from 'react';
import {
  View, Text, TextInput, ScrollView, StyleSheet,
  TouchableOpacity, Platform, ActivityIndicator,
  KeyboardAvoidingView,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Colors, FontSize, Spacing, Radius } from '../../constants/theme';
import { apiFetch } from '../../services/api';

interface UserResult {
  user_id: string;
  username: string;
  role: string;
  portfolio_score?: number | null;
}

export function ComposeMessageScreen() {
  const navigation = useNavigation<any>();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<UserResult[]>([]);
  const [searching, setSearching] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const search = useCallback((q: string) => {
    setQuery(q);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (q.trim().length < 2) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const data = await apiFetch(`/api/users/search?q=${encodeURIComponent(q.trim())}`);
        setResults(data.users || []);
      } catch {
        setResults([]);
      }
      setSearching(false);
    }, 300);
  }, []);

  const selectUser = (user: UserResult) => {
    navigation.replace('Chat', {
      userId: user.user_id,
      username: user.username,
    });
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <View style={styles.container}>
      <View style={styles.searchBar}>
        <Ionicons name="search" size={18} color={Colors.textDim} />
        <TextInput
          style={styles.searchInput}
          value={query}
          onChangeText={search}
          placeholder="Search by username..."
          placeholderTextColor={Colors.textDim}
          autoFocus
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
        />
        {query.length > 0 && (
          <TouchableOpacity activeOpacity={0.7} onPress={() => search('')}>
            <Ionicons name="close-circle" size={18} color={Colors.textDim} />
          </TouchableOpacity>
        )}
      </View>

      {searching && (
        <View style={styles.loadingRow}>
          <ActivityIndicator size="small" color={Colors.primary} />
        </View>
      )}

      <ScrollView style={styles.results} keyboardDismissMode="on-drag">
        {results.map(user => {
          const initial = (user.username || '?')[0].toUpperCase();
          return (
            <TouchableOpacity
              key={user.user_id}
              activeOpacity={0.7}
              style={styles.userRow}
              onPress={() => selectUser(user)}
            >
              <View style={styles.userAvatar}>
                <Text style={styles.userAvatarText}>{initial}</Text>
              </View>
              <View style={styles.userInfo}>
                <Text style={styles.userName}>{user.username}</Text>
                <Text style={styles.userRole}>
                  {user.role === 'cleaner' ? 'Cleaner' : 'Host'}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={16} color={Colors.textDim} />
            </TouchableOpacity>
          );
        })}
        {!searching && query.length >= 2 && results.length === 0 && (
          <View style={styles.noResults}>
            <Text style={styles.noResultsText}>No users found</Text>
          </View>
        )}
      </ScrollView>
    </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  searchBar: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    marginHorizontal: Spacing.md, marginTop: Spacing.sm,
    backgroundColor: Colors.glassHeavy,
    borderWidth: 0.5, borderColor: Colors.glassBorder,
    borderRadius: Radius.lg,
    paddingHorizontal: Spacing.md,
    paddingVertical: Platform.OS === 'ios' ? 10 : 8,
  },
  searchInput: {
    flex: 1, fontSize: FontSize.md, color: Colors.text,
  },
  loadingRow: {
    alignItems: 'center', paddingVertical: Spacing.md,
  },
  results: { flex: 1, marginTop: Spacing.sm },
  userRow: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm + 2,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Colors.border,
  },
  userAvatar: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: Colors.glassDark, borderWidth: 0.5, borderColor: Colors.glassBorder,
    alignItems: 'center', justifyContent: 'center',
  },
  userAvatarText: { fontSize: FontSize.md, fontWeight: '700', color: Colors.textSecondary },
  userInfo: { flex: 1 },
  userName: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  userRole: { fontSize: FontSize.xs, color: Colors.textDim, marginTop: 1 },
  noResults: { alignItems: 'center', paddingVertical: Spacing.xl },
  noResultsText: { fontSize: FontSize.sm, color: Colors.textDim },
});
