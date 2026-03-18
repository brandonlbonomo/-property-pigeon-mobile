import React, { useEffect, useCallback, useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, RefreshControl, Platform, ActivityIndicator,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Colors, FontSize, Spacing, Radius } from '../../constants/theme';
import { useFeedStore, FeedPost } from '../../store/feedStore';
import { PortfolioScoreBubble } from '../../components/PortfolioScoreBubble';

const TYPE_ICONS: Record<string, string> = {
  milestone: 'trophy-outline',
  financial: 'trending-up-outline',
  property_added: 'home-outline',
  default: 'newspaper-outline',
};

function timeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = now - then;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

function FeedCard({ post }: { post: FeedPost }) {
  const icon = TYPE_ICONS[post.type] || TYPE_ICONS.default;
  const isCleaner = post.role === 'cleaner';
  const hasScore = !isCleaner && post.portfolio_score != null;

  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        {hasScore ? (
          <PortfolioScoreBubble score={post.portfolio_score} size={32} />
        ) : (
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>
              {(post.username || '?')[0].toUpperCase()}
            </Text>
          </View>
        )}
        <View style={styles.headerInfo}>
          <Text style={styles.username}>{post.username}</Text>
          <Text style={styles.time}>{timeAgo(post.created_at)}</Text>
        </View>
        <Ionicons name={icon as any} size={18} color={Colors.textDim} />
      </View>
      <Text style={styles.cardBody}>{post.body}</Text>
    </View>
  );
}

export function FeedScreen() {
  const { posts, loading, fetchFeed } = useFeedStore();
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchFeed().catch(() => setError('Could not load feed.'));
  }, []);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try { await fetchFeed(true); }
    catch { setError('Could not load feed.'); }
    finally { setRefreshing(false); }
  }, [fetchFeed]);

  if (loading && posts.length === 0) {
    return (
      <View style={styles.emptyContainer}>
        <ActivityIndicator size="large" color={Colors.green} />
      </View>
    );
  }

  if (posts.length === 0 && !loading) {
    return (
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.emptyContainer}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={"#FFFFFF"} colors={["#FFFFFF"]} />}
      >
        {error && (
          <View style={styles.errorBanner}>
            <Ionicons name="cloud-offline-outline" size={16} color={Colors.red} />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}
        <Ionicons name="newspaper-outline" size={48} color={Colors.textDim} />
        <Text style={styles.emptyTitle}>Feed</Text>
        <Text style={styles.emptySub}>
          Follow investors to see their updates here
        </Text>
      </ScrollView>
    );
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={"#FFFFFF"} colors={["#FFFFFF"]} />}
    >
      {error && (
        <View style={styles.errorBanner}>
          <Ionicons name="cloud-offline-outline" size={16} color={Colors.red} />
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}
      {posts.map(post => (
        <FeedCard key={post.id} post={post} />
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  content: { padding: Spacing.md, paddingBottom: Spacing.xl * 2 },
  emptyContainer: {
    flex: 1, alignItems: 'center', justifyContent: 'center', padding: Spacing.xl,
  },
  emptyTitle: { fontSize: 20, fontWeight: '700', color: Colors.text, marginTop: Spacing.md },
  emptySub: {
    fontSize: 14, color: Colors.textSecondary, textAlign: 'center',
    marginTop: Spacing.xs, lineHeight: 20,
  },
  card: {
    padding: Spacing.md,
    backgroundColor: Colors.glassHeavy, borderRadius: Radius.lg,
    borderWidth: 0.5, borderColor: Colors.glassBorder,
    marginBottom: Spacing.sm,
    ...Platform.select({
      ios: { shadowColor: Colors.glassShadow, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.35, shadowRadius: 20 },
      android: { elevation: 2 },
    }),
  },
  cardHeader: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    marginBottom: Spacing.sm,
  },
  avatar: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: Colors.greenDim, alignItems: 'center', justifyContent: 'center',
  },
  avatarText: { fontSize: FontSize.sm, fontWeight: '700', color: Colors.primary },
  headerInfo: { flex: 1 },
  username: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.text },
  time: { fontSize: FontSize.xs, color: Colors.textDim },
  cardBody: { fontSize: FontSize.md, color: Colors.text, lineHeight: 22 },
  errorBanner: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    backgroundColor: 'rgba(239,68,68,0.08)', borderRadius: Radius.md,
    padding: Spacing.sm, marginBottom: Spacing.md, borderWidth: 0.5, borderColor: 'rgba(239,68,68,0.20)',
    alignSelf: 'stretch',
  },
  errorText: { fontSize: FontSize.xs, color: Colors.red, flex: 1, lineHeight: 16 },
});
