import React, { useState, useCallback, useRef } from 'react';
import {
  View, Text, TextInput, ScrollView, StyleSheet,
  TouchableOpacity, ActivityIndicator, Platform, Alert,
  KeyboardAvoidingView,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useNavigation } from '@react-navigation/native';
import { Colors, FontSize, Spacing, Radius } from '../../constants/theme';
import { apiFetch } from '../../services/api';
import { PortfolioScoreBubble } from '../../components/PortfolioScoreBubble';

interface SearchResult {
  user_id: string;
  username: string;
  role: 'owner' | 'cleaner';
  is_private?: boolean;
  portfolio_score?: number | null;
}

export function SearchScreen() {
  const navigation = useNavigation<any>();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [followingIds, setFollowingIds] = useState<Set<string>>(new Set<string>());
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set<string>());
  const [searchError, setSearchError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const followsLoaded = useRef(false);

  // Load existing follows on mount so already-followed users show as "Following"
  React.useEffect(() => {
    if (followsLoaded.current) return;
    followsLoaded.current = true;
    apiFetch('/api/follow/following').then((res: any) => {
      const ids = new Set<string>((res.following || []).map((f: any) => f.user_id));
      if (ids.size > 0) setFollowingIds(ids);
    }).catch(() => {});
  }, []);

  const search = useCallback((q: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (q.trim().length < 2) {
      setResults([]);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      setSearchError(null);
      try {
        const res = await apiFetch(`/api/users/search?q=${encodeURIComponent(q.trim())}`);
        setResults(res.users || []);
      } catch {
        setResults([]);
        setSearchError('Search failed. Please try again.');
      }
      setLoading(false);
    }, 400);
  }, []);

  const handleFollow = async (userId: string) => {
    try {
      const res = await apiFetch('/api/follow/request', {
        method: 'POST',
        body: JSON.stringify({ username: results.find(r => r.user_id === userId)?.username }),
      });
      if (res.status === 'pending') {
        setPendingIds(prev => new Set(prev).add(userId));
      } else {
        setFollowingIds(prev => new Set(prev).add(userId));
      }
    } catch (err: any) {
      const msg = err?.serverError || err?.message || 'Could not follow this user.';
      if (msg.includes('Already following')) {
        setFollowingIds(prev => new Set(prev).add(userId));
      } else {
        Alert.alert('Follow Failed', msg);
      }
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <View style={styles.container}>
      <View style={styles.searchBar}>
        <Ionicons name="search" size={18} color={Colors.textDim} />
        <TextInput
          style={styles.searchInput}
          value={query}
          onChangeText={q => { setQuery(q); search(q); }}
          placeholder="Search by username..."
          placeholderTextColor={Colors.textDim}
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
        />
        {query.length > 0 && (
          <TouchableOpacity activeOpacity={0.7}
          onPress={() => { setQuery(''); setResults([]); }}>
            <Ionicons name="close-circle" size={18} color={Colors.textDim} />
          </TouchableOpacity>
        )}
      </View>

      {loading && <ActivityIndicator size="small" color={Colors.primary} style={{ marginTop: Spacing.lg }} />}

      <ScrollView contentContainerStyle={styles.content}>
        {searchError && (
          <View style={styles.errorBanner}>
            <Ionicons name="cloud-offline-outline" size={16} color={Colors.red} />
            <Text style={styles.errorText}>{searchError}</Text>
          </View>
        )}
        {!loading && !searchError && query.length >= 2 && results.length === 0 && (
          <View style={styles.empty}>
            <Text style={styles.emptyText}>No users found for "{query}"</Text>
          </View>
        )}

        {results.map(user => {
          const isFollowing = followingIds.has(user.user_id);
          const isPending = pendingIds.has(user.user_id);
          const isDone = isFollowing || isPending;
          return (
            <View key={user.user_id} style={styles.userCard}>
              {user.role !== 'cleaner' && user.portfolio_score != null ? (
                <PortfolioScoreBubble score={user.portfolio_score} size={40} />
              ) : (
                <View style={styles.avatar}>
                  <Text style={styles.avatarText}>
                    {(user.username || '?')[0].toUpperCase()}
                  </Text>
                </View>
              )}
              <View style={styles.userInfo}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                  <Text style={styles.username}>{user.username}</Text>
                  {user.is_private && <Ionicons name="lock-closed" size={10} color={Colors.textDim} />}
                </View>
                <View style={styles.roleBadge}>
                  <Text style={styles.roleText}>
                    {user.role === 'cleaner' ? 'Cleaner' : 'Owner'}
                  </Text>
                </View>
              </View>
              <TouchableOpacity activeOpacity={0.7}
                style={styles.msgBtn}
                onPress={() => navigation.navigate('Chat', { userId: user.user_id, username: user.username })}
              >
                <Ionicons name="chatbubble-outline" size={14} color={Colors.primary} />
              </TouchableOpacity>
              <TouchableOpacity activeOpacity={0.7}
                style={[styles.followBtn, isFollowing && styles.followBtnDone, isPending && styles.followBtnPending]}
                onPress={() => !isDone && handleFollow(user.user_id)}
                disabled={isDone}
              >
                <Ionicons
                  name={isFollowing ? 'checkmark' : isPending ? 'time-outline' : 'person-add-outline'}
                  size={14}
                  color={isFollowing ? Colors.green : isPending ? Colors.yellow : '#fff'}
                />
                <Text style={[styles.followBtnText, isFollowing && styles.followBtnTextDone, isPending && styles.followBtnTextPending]}>
                  {isFollowing ? 'Following' : isPending ? 'Requested' : 'Follow'}
                </Text>
              </TouchableOpacity>
            </View>
          );
        })}
      </ScrollView>
    </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  searchBar: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    margin: Spacing.md, padding: Spacing.sm, paddingHorizontal: Spacing.md,
    backgroundColor: Colors.glassHeavy, borderRadius: Radius.lg,
    borderWidth: 0.5, borderColor: Colors.glassBorder,
  },
  searchInput: {
    flex: 1, fontSize: FontSize.md, color: Colors.text,
    paddingVertical: Spacing.xs,
  },
  content: { padding: Spacing.md, paddingTop: 0 },
  empty: { alignItems: 'center', paddingTop: Spacing.xl * 2 },
  emptyText: { fontSize: FontSize.sm, color: Colors.textDim },
  userCard: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    padding: Spacing.md,
    backgroundColor: Colors.glassHeavy, borderRadius: Radius.lg,
    borderWidth: 0.5, borderColor: Colors.glassBorder,
    marginBottom: Spacing.sm,
    ...Platform.select({
      ios: { shadowColor: Colors.glassShadow, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.35, shadowRadius: 20 },
      android: { elevation: 2 },
    }),
  },
  avatar: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: Colors.greenDim, alignItems: 'center', justifyContent: 'center',
  },
  avatarText: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.primary },
  userInfo: { flex: 1 },
  username: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  roleBadge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 6, paddingVertical: 1,
    borderRadius: Radius.pill, backgroundColor: Colors.glassDark,
    marginTop: 2,
  },
  roleText: { fontSize: 10, fontWeight: '500', color: Colors.textSecondary },
  followBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: Spacing.sm, paddingVertical: 6,
    borderRadius: Radius.pill, backgroundColor: Colors.green,
  },
  followBtnDone: {
    backgroundColor: Colors.greenDim, borderWidth: 1, borderColor: Colors.green,
  },
  followBtnPending: {
    backgroundColor: Colors.yellowDim, borderWidth: 1, borderColor: Colors.yellow,
  },
  followBtnText: { fontSize: FontSize.xs, fontWeight: '600', color: '#fff' },
  followBtnTextDone: { color: Colors.green },
  followBtnTextPending: { color: Colors.yellow },
  msgBtn: {
    width: 34, height: 34, borderRadius: 17,
    borderWidth: 1, borderColor: Colors.primary + '40',
    backgroundColor: Colors.greenDim,
    alignItems: 'center', justifyContent: 'center',
  },
  errorBanner: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    backgroundColor: 'rgba(239,68,68,0.08)', borderRadius: Radius.md,
    padding: Spacing.sm, marginBottom: Spacing.md, borderWidth: 0.5, borderColor: 'rgba(239,68,68,0.20)',
  },
  errorText: { fontSize: FontSize.xs, color: Colors.red, flex: 1, lineHeight: 16 },
});
