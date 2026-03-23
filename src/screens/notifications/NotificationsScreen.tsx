import React, { useEffect, useCallback, useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, RefreshControl,
  TouchableOpacity, Platform, ActivityIndicator,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useNavigation } from '@react-navigation/native';
import { Colors, FontSize, Spacing, Radius } from '../../constants/theme';
import { useNotificationStore, AppNotification } from '../../store/notificationStore';
import { apiFetch } from '../../services/api';

const TYPE_ICONS: Record<string, string> = {
  cleaning: 'sparkles-outline',
  checkin: 'calendar-outline',
  inventory: 'cube-outline',
  financial: 'cash-outline',
  milestone: 'trophy-outline',
  follow: 'person-add-outline',
  message: 'chatbubble-outline',
  property_request: 'key-outline',
  property_invite: 'mail-outline',
  invoice: 'receipt-outline',
  default: 'notifications-outline',
};

const TYPE_COLORS: Record<string, string> = {
  cleaning: Colors.yellow,
  checkin: Colors.green,
  inventory: Colors.red,
  financial: Colors.primary,
  milestone: '#F59E0B',
  follow: Colors.primary,
  message: Colors.green,
  property_request: Colors.primary,
  property_invite: Colors.green,
  invoice: Colors.yellow,
  default: Colors.textSecondary,
};

function timeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = now - then;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d`;
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function NotificationCard({ notif, onPress, onFollowBack }: {
  notif: AppNotification;
  onPress: () => void;
  onFollowBack?: () => void;
}) {
  const icon = TYPE_ICONS[notif.type] || TYPE_ICONS.default;
  const color = TYPE_COLORS[notif.type] || TYPE_COLORS.default;
  const isFollow = notif.type === 'follow' || notif.type === 'follow_request';
  const senderName = notif.data?.sender_name || '';
  const initial = senderName ? senderName.charAt(0).toUpperCase() : '';

  return (
    <TouchableOpacity
      activeOpacity={0.7}
      style={[styles.card, !notif.read && styles.cardUnread]}
      onPress={onPress}
    >
      {isFollow && initial ? (
        <View style={[styles.avatarCircle, { backgroundColor: Colors.green + '20' }]}>
          <Text style={[styles.avatarInitial, { color: Colors.green }]}>{initial}</Text>
        </View>
      ) : (
        <View style={[styles.iconCircle, { backgroundColor: color + '18' }]}>
          <Ionicons name={icon as any} size={16} color={color} />
        </View>
      )}
      <View style={styles.cardContent}>
        <Text style={styles.cardBody} numberOfLines={2}>
          <Text style={styles.cardBold}>{notif.title}</Text>
          {'  '}
          {notif.body}
        </Text>
        <Text style={styles.cardTime}>{timeAgo(notif.created_at)}</Text>
      </View>
      {isFollow && onFollowBack && (
        <TouchableOpacity
          activeOpacity={0.7}
          style={styles.followBackBtn}
          onPress={onFollowBack}
        >
          <Text style={styles.followBackText}>Follow</Text>
        </TouchableOpacity>
      )}
      {!notif.read && !isFollow && <View style={styles.unreadDot} />}
      {isFollow && !onFollowBack && <Ionicons name="chevron-forward" size={14} color={Colors.textDim} />}
    </TouchableOpacity>
  );
}

export function NotificationsScreen() {
  const navigation = useNavigation<any>();
  const { notifications, fetchNotifications, markAllRead, markRead } = useNotificationStore();
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [followingBack, setFollowingBack] = useState<Set<string>>(new Set());
  const [followedBack, setFollowedBack] = useState<Set<string>>(new Set());

  useEffect(() => {
    fetchNotifications()
      .catch(() => setError('Could not load notifications.'))
      .finally(() => setLoading(false));
  }, []);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try { await fetchNotifications(); }
    catch { setError('Could not load notifications.'); }
    finally { setRefreshing(false); }
  }, [fetchNotifications]);

  const handlePress = useCallback((notif: AppNotification) => {
    // Mark as read on tap
    if (!notif.read) markRead([notif.id]);

    const data = notif.data || {};

    switch (notif.type) {
      case 'message':
        if (data.conv_id && data.sender_id) {
          navigation.navigate('Chat', {
            conversationId: data.conv_id,
            otherUserId: data.sender_id,
            otherUsername: data.sender_name || notif.title,
          });
        } else {
          navigation.navigate('Conversations');
        }
        break;
      case 'follow':
      case 'follow_request':
        if (data.sender_id) {
          navigation.navigate('ViewUserProfile', {
            userId: data.sender_id,
            username: data.sender_name || '',
          });
        }
        break;
      case 'property_request':
      case 'property_invite':
        if (data.conv_id && data.sender_id) {
          navigation.navigate('Chat', {
            conversationId: data.conv_id,
            otherUserId: data.sender_id,
            otherUsername: data.sender_name || notif.title,
          });
        }
        break;
      case 'invoice':
        // Navigate to Settings invoices section
        navigation.navigate('Settings', { section: 'invoices' });
        break;
      default:
        // No specific navigation for other types
        break;
    }
  }, [navigation, markRead]);

  const handleFollowBack = useCallback(async (notif: AppNotification) => {
    const senderId = notif.data?.sender_id;
    const senderName = notif.data?.sender_name || notif.title;
    if (!senderId) return;
    if (followingBack.has(notif.id) || followedBack.has(notif.id)) return;

    setFollowingBack(prev => new Set([...prev, notif.id]));
    try {
      await apiFetch('/api/follow/request', {
        method: 'POST',
        body: JSON.stringify({ username: senderName }),
      });
      setFollowedBack(prev => new Set([...prev, notif.id]));
    } catch {
      // Silently fail - may already be following
      setFollowedBack(prev => new Set([...prev, notif.id]));
    } finally {
      setFollowingBack(prev => {
        const next = new Set(prev);
        next.delete(notif.id);
        return next;
      });
    }
  }, [followingBack, followedBack]);

  const hasUnread = notifications.some(n => !n.read);

  if (loading && notifications.length === 0) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={Colors.green} />
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={"#1A1A1A"} colors={["#1A1A1A"]} />}
    >
      {error && (
        <View style={styles.errorBanner}>
          <Ionicons name="cloud-offline-outline" size={14} color={Colors.red} />
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      {hasUnread && (
        <TouchableOpacity activeOpacity={0.7} style={styles.markAllBtn} onPress={markAllRead}>
          <Text style={styles.markAllText}>Mark all read</Text>
        </TouchableOpacity>
      )}

      {notifications.length === 0 ? (
        <View style={styles.empty}>
          <View style={styles.emptyIcon}>
            <Ionicons name="notifications-off-outline" size={32} color={Colors.textDim} />
          </View>
          <Text style={styles.emptyTitle}>No notifications</Text>
          <Text style={styles.emptySub}>
            Activity will appear here
          </Text>
        </View>
      ) : (
        notifications.map(n => (
          <NotificationCard
            key={n.id}
            notif={n}
            onPress={() => handlePress(n)}
            onFollowBack={
              (n.type === 'follow' || n.type === 'follow_request') && !followedBack.has(n.id)
                ? () => handleFollowBack(n)
                : undefined
            }
          />
        ))
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  content: { padding: Spacing.sm, paddingBottom: Spacing.xl * 2 },
  loadingContainer: { flex: 1, backgroundColor: Colors.bg, alignItems: 'center', justifyContent: 'center' },

  markAllBtn: { alignSelf: 'flex-end', marginBottom: Spacing.xs, paddingHorizontal: Spacing.xs },
  markAllText: { fontSize: FontSize.xs, color: Colors.primary, fontWeight: '500' },

  card: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: Spacing.sm,
    paddingVertical: 10,
    backgroundColor: Colors.glass,
    borderRadius: Radius.lg,
    borderWidth: 0.5,
    borderColor: Colors.glassBorder,
    borderTopWidth: 1,
    borderTopColor: Colors.glassHighlight,
    marginBottom: 6,
    gap: Spacing.sm,
    overflow: 'hidden',
    ...Platform.select({
      ios: {
        shadowColor: Colors.glassShadow,
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.25,
        shadowRadius: 12,
      },
      android: { elevation: 2 },
    }),
  },
  cardUnread: {
    backgroundColor: Colors.greenDim,
    borderColor: 'rgba(59,130,246,0.15)',
  },
  iconCircle: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarCircle: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 0.5,
    borderColor: Colors.glassBorder,
  },
  avatarInitial: {
    fontSize: FontSize.xs,
    fontWeight: '700',
  },
  cardContent: { flex: 1 },
  cardBold: { fontWeight: '600', color: Colors.text, fontSize: FontSize.xs },
  cardBody: { fontSize: FontSize.xs, color: Colors.textSecondary, lineHeight: 16 },
  cardTime: { fontSize: 10, color: Colors.textDim, marginTop: 2 },
  unreadDot: {
    width: 7, height: 7, borderRadius: 3.5,
    backgroundColor: Colors.green,
  },

  followBackBtn: {
    backgroundColor: Colors.green,
    paddingHorizontal: Spacing.sm + 2,
    paddingVertical: 5,
    borderRadius: Radius.pill,
  },
  followBackText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#fff',
  },

  errorBanner: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.xs,
    backgroundColor: 'rgba(239,68,68,0.08)', borderRadius: Radius.md,
    padding: Spacing.sm, marginBottom: Spacing.sm, borderWidth: 0.5, borderColor: 'rgba(239,68,68,0.20)',
  },
  errorText: { fontSize: FontSize.xs, color: Colors.red, flex: 1 },

  empty: {
    alignItems: 'center', justifyContent: 'center',
    paddingVertical: Spacing.xl * 3,
  },
  emptyIcon: {
    width: 56, height: 56, borderRadius: 28,
    backgroundColor: Colors.glass,
    borderWidth: 0.5, borderColor: Colors.glassBorder,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: Spacing.sm,
    ...Platform.select({
      ios: {
        shadowColor: Colors.glassShadow,
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.2,
        shadowRadius: 10,
      },
    }),
  },
  emptyTitle: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  emptySub: {
    fontSize: FontSize.xs, color: Colors.textSecondary,
    textAlign: 'center', marginTop: 2, lineHeight: 16,
  },
});
