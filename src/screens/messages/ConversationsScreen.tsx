import React, { useEffect, useCallback, useState, useRef } from 'react';
import {
  View, Text, ScrollView, StyleSheet, RefreshControl,
  TouchableOpacity, Platform, ActivityIndicator, Animated, Pressable,
  PanResponder, Alert,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Colors, FontSize, Spacing, Radius } from '../../constants/theme';
import { useMessageStore, Conversation } from '../../store/messageStore';

function timeAgo(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d`;
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

const DELETE_WIDTH = 80;

function ConversationRow({ convo, onPress, onDelete }: { convo: Conversation; onPress: () => void; onDelete: () => void }) {
  const translateX = useRef(new Animated.Value(0)).current;
  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 25 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
      onPanResponderMove: (_, g) => {
        if (g.dx < 0) translateX.setValue(Math.max(g.dx, -DELETE_WIDTH));
      },
      onPanResponderRelease: (_, g) => {
        if (g.dx < -DELETE_WIDTH / 2) {
          Animated.spring(translateX, { toValue: -DELETE_WIDTH, useNativeDriver: true, tension: 180, friction: 14 }).start();
        } else {
          Animated.spring(translateX, { toValue: 0, useNativeDriver: true, tension: 180, friction: 14 }).start();
        }
      },
    })
  ).current;

  const handleDelete = () => {
    Animated.timing(translateX, { toValue: 0, duration: 200, useNativeDriver: true }).start();
    onDelete();
  };

  const isGroup = convo.is_group;
  const hasUnread = convo.unread_count > 0;

  const rowContent = isGroup ? (
    <>
      <View style={[styles.groupAvatar, hasUnread && styles.avatarUnread]}>
        <Ionicons name="people" size={22} color={hasUnread ? Colors.primary : Colors.textSecondary} />
      </View>
      <View style={styles.convoContent}>
        <View style={styles.convoTop}>
          <Text style={[styles.convoName, hasUnread && styles.convoNameUnread]}>
            {convo.group_name || 'Group Chat'}
          </Text>
          <Text style={styles.convoTime}>{timeAgo(convo.updated_at)}</Text>
        </View>
        <Text style={[styles.convoPreview, hasUnread && styles.convoPreviewUnread]} numberOfLines={1}>
          {convo.last_message.sender_name
            ? `${convo.last_message.sender_name}: ${convo.last_message.text || (convo.last_message.has_attachments ? 'Sent an attachment' : '')}`
            : convo.last_message.text || (convo.last_message.has_attachments ? 'Sent an attachment' : '')}
        </Text>
      </View>
      {hasUnread && (
        <View style={styles.unreadBadge}>
          <Text style={styles.unreadText}>{convo.unread_count}</Text>
        </View>
      )}
    </>
  ) : (
    <>
      <View style={[styles.avatar, hasUnread && styles.avatarUnread]}>
        <Text style={styles.avatarText}>{(convo.other_user?.username || '?')[0].toUpperCase()}</Text>
      </View>
      <View style={styles.convoContent}>
        <View style={styles.convoTop}>
          <Text style={[styles.convoName, hasUnread && styles.convoNameUnread]}>
            {convo.other_user?.username}
          </Text>
          <Text style={styles.convoTime}>{timeAgo(convo.updated_at)}</Text>
        </View>
        <Text style={[styles.convoPreview, hasUnread && styles.convoPreviewUnread]} numberOfLines={1}>
          {convo.last_message.text || (convo.last_message.has_attachments ? 'Sent an attachment' : '')}
        </Text>
      </View>
      {hasUnread && (
        <View style={styles.unreadBadge}>
          <Text style={styles.unreadText}>{convo.unread_count}</Text>
        </View>
      )}
    </>
  );

  return (
    <View style={styles.swipeContainer}>
      {/* Delete action behind the row */}
      <TouchableOpacity activeOpacity={0.7} style={styles.deleteAction} onPress={handleDelete}>
        <Ionicons name="trash-outline" size={22} color="#fff" />
        <Text style={styles.deleteText}>Delete</Text>
      </TouchableOpacity>
      {/* Swipeable foreground */}
      <Animated.View style={{ transform: [{ translateX }] }} {...panResponder.panHandlers}>
        <TouchableOpacity activeOpacity={0.7} style={styles.convoRow} onPress={onPress}>
          {rowContent}
        </TouchableOpacity>
      </Animated.View>
    </View>
  );
}

function ComposeFAB() {
  const navigation = useNavigation<any>();
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);

  const fabRotation = useRef(new Animated.Value(0)).current;
  const pill1 = useRef(new Animated.Value(0)).current;
  const pill2 = useRef(new Animated.Value(0)).current;

  const toggle = () => {
    const next = !open;
    setOpen(next);

    if (next) {
      Animated.parallel([
        Animated.spring(fabRotation, { toValue: 1, useNativeDriver: true, tension: 180, friction: 12 }),
        Animated.spring(pill1, { toValue: 1, useNativeDriver: true, tension: 160, friction: 12 }),
        Animated.sequence([
          Animated.delay(80),
          Animated.spring(pill2, { toValue: 1, useNativeDriver: true, tension: 160, friction: 12 }),
        ]),
      ]).start();
    } else {
      Animated.parallel([
        Animated.spring(fabRotation, { toValue: 0, useNativeDriver: true, tension: 180, friction: 12 }),
        Animated.spring(pill2, { toValue: 0, useNativeDriver: true, tension: 180, friction: 12 }),
        Animated.sequence([
          Animated.delay(40),
          Animated.spring(pill1, { toValue: 0, useNativeDriver: true, tension: 180, friction: 12 }),
        ]),
      ]).start();
    }
  };

  const rotate = fabRotation.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '45deg'] });
  const pill1Style = {
    opacity: pill1,
    transform: [
      { translateY: pill1.interpolate({ inputRange: [0, 1], outputRange: [20, 0] }) },
      { scale: pill1.interpolate({ inputRange: [0, 1], outputRange: [0.8, 1] }) },
    ],
  };
  const pill2Style = {
    opacity: pill2,
    transform: [
      { translateY: pill2.interpolate({ inputRange: [0, 1], outputRange: [20, 0] }) },
      { scale: pill2.interpolate({ inputRange: [0, 1], outputRange: [0.8, 1] }) },
    ],
  };

  const handleNewMessage = () => {
    setOpen(false);
    fabRotation.setValue(0);
    pill1.setValue(0);
    pill2.setValue(0);
    navigation.navigate('ComposeMessage');
  };

  const handleGroupChat = () => {
    setOpen(false);
    fabRotation.setValue(0);
    pill1.setValue(0);
    pill2.setValue(0);
    navigation.navigate('ComposeGroup');
  };

  return (
    <View style={[styles.fabContainer, { bottom: insets.bottom + 16 }]}>
      {/* Backdrop */}
      {open && (
        <Pressable style={StyleSheet.absoluteFill} onPress={toggle} />
      )}

      {/* Group Chat pill */}
      <Animated.View style={[styles.pillWrap, pill2Style]}>
        <TouchableOpacity activeOpacity={0.7} style={styles.glassPill} onPress={handleGroupChat}>
          <Ionicons name="people-outline" size={18} color={Colors.text} />
          <Text style={styles.pillText}>Group Chat</Text>
        </TouchableOpacity>
      </Animated.View>

      {/* New Message pill */}
      <Animated.View style={[styles.pillWrap, pill1Style]}>
        <TouchableOpacity activeOpacity={0.7} style={styles.glassPill} onPress={handleNewMessage}>
          <Ionicons name="chatbubble-outline" size={18} color={Colors.text} />
          <Text style={styles.pillText}>New Message</Text>
        </TouchableOpacity>
      </Animated.View>

      {/* FAB */}
      <TouchableOpacity activeOpacity={0.7} style={styles.fab} onPress={toggle}>
        <Animated.View style={{ transform: [{ rotate }] }}>
          <Ionicons name="create-outline" size={24} color="#fff" />
        </Animated.View>
      </TouchableOpacity>
    </View>
  );
}

export function ConversationsScreen() {
  const navigation = useNavigation<any>();
  const { conversations, fetchConversations, deleteConversation } = useMessageStore();
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchConversations()
      .catch(() => setError('Could not load messages.'))
      .finally(() => setLoading(false));
  }, []);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try { await fetchConversations(); }
    catch { setError('Could not load messages.'); }
    finally { setRefreshing(false); }
  }, [fetchConversations]);

  const handleConvoPress = (convo: Conversation) => {
    if (convo.is_group) {
      navigation.navigate('Chat', {
        convId: convo.id,
        groupName: convo.group_name,
      });
    } else {
      navigation.navigate('Chat', {
        userId: convo.other_user?.id,
        username: convo.other_user?.username,
      });
    }
  };

  if (loading && conversations.length === 0) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={Colors.green} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={"#FFFFFF"} colors={["#FFFFFF"]} />}
      >
        {error && (
          <View style={styles.errorBanner}>
            <Ionicons name="cloud-offline-outline" size={16} color={Colors.red} />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}
        {conversations.length === 0 ? (
          <View style={styles.empty}>
            <Ionicons name="chatbubbles-outline" size={48} color={Colors.textDim} />
            <Text style={styles.emptyTitle}>No messages yet</Text>
            <Text style={styles.emptySub}>
              Tap the compose button to start a conversation
            </Text>
          </View>
        ) : (
          conversations.map(convo => (
            <ConversationRow
              key={convo.id}
              convo={convo}
              onPress={() => handleConvoPress(convo)}
              onDelete={() => {
                Alert.alert(
                  'Delete Conversation',
                  'This conversation will be removed from your inbox.',
                  [
                    { text: 'Cancel', style: 'cancel' },
                    { text: 'Delete', style: 'destructive', onPress: () => deleteConversation(convo.id) },
                  ],
                );
              }}
            />
          ))
        )}
      </ScrollView>

      <ComposeFAB />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  scrollView: { flex: 1 },
  content: { paddingBottom: Spacing.xl + 80 },

  swipeContainer: {
    overflow: 'hidden',
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Colors.border,
  },
  deleteAction: {
    position: 'absolute', right: 0, top: 0, bottom: 0,
    width: DELETE_WIDTH, backgroundColor: Colors.red,
    alignItems: 'center', justifyContent: 'center', gap: 2,
  },
  deleteText: { fontSize: FontSize.xs, fontWeight: '600', color: '#fff' },
  convoRow: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
    backgroundColor: Colors.bg,
  },
  avatar: {
    width: 48, height: 48, borderRadius: 24,
    backgroundColor: Colors.glassDark, borderWidth: 0.5, borderColor: Colors.glassBorder,
    alignItems: 'center', justifyContent: 'center',
  },
  groupAvatar: {
    width: 48, height: 48, borderRadius: 24,
    backgroundColor: Colors.glassDark, borderWidth: 0.5, borderColor: Colors.glassBorder,
    alignItems: 'center', justifyContent: 'center',
  },
  avatarUnread: {
    backgroundColor: Colors.primaryDim, borderColor: Colors.primary,
  },
  avatarText: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.textSecondary },
  convoContent: { flex: 1 },
  convoTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  convoName: { fontSize: FontSize.md, fontWeight: '500', color: Colors.text },
  convoNameUnread: { fontWeight: '700' },
  convoTime: { fontSize: FontSize.xs, color: Colors.textDim },
  convoPreview: { fontSize: FontSize.sm, color: Colors.textDim, marginTop: 2 },
  convoPreviewUnread: { color: Colors.text, fontWeight: '500' },
  unreadBadge: {
    minWidth: 20, height: 20, borderRadius: 10,
    backgroundColor: Colors.primary, alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 6,
  },
  unreadText: { fontSize: 10, fontWeight: '800', color: '#fff' },

  loadingContainer: { flex: 1, backgroundColor: Colors.bg, alignItems: 'center', justifyContent: 'center' },
  errorBanner: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    backgroundColor: 'rgba(239,68,68,0.08)', borderRadius: Radius.md,
    padding: Spacing.sm, marginHorizontal: Spacing.md, marginTop: Spacing.sm, borderWidth: 0.5, borderColor: 'rgba(239,68,68,0.20)',
  },
  errorText: { fontSize: FontSize.xs, color: Colors.red, flex: 1, lineHeight: 16 },
  empty: {
    alignItems: 'center', justifyContent: 'center', paddingVertical: Spacing.xl * 3,
  },
  emptyTitle: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text, marginTop: Spacing.md },
  emptySub: {
    fontSize: FontSize.sm, color: Colors.textSecondary,
    textAlign: 'center', marginTop: Spacing.xs, lineHeight: 20,
  },

  // FAB + pills
  fabContainer: {
    position: 'absolute', right: Spacing.md,
    alignItems: 'flex-end', gap: Spacing.sm,
  },
  fab: {
    width: 56, height: 56, borderRadius: 28,
    backgroundColor: Colors.primary,
    alignItems: 'center', justifyContent: 'center',
    ...Platform.select({
      ios: {
        shadowColor: Colors.glassShadow,
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.35,
        shadowRadius: 12,
      },
      android: { elevation: 6 },
    }),
  },
  pillWrap: {
    alignItems: 'flex-end',
  },
  glassPill: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    backgroundColor: Colors.glass,
    borderWidth: 1,
    borderColor: Colors.glassBorder,
    borderTopWidth: 1.5,
    borderTopColor: Colors.glassHighlight,
    borderRadius: Radius.pill,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm + 2,
    ...Platform.select({
      ios: {
        shadowColor: Colors.glassShadow,
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.25,
        shadowRadius: 10,
      },
      android: { elevation: 4 },
    }),
  },
  pillText: {
    fontSize: FontSize.sm, fontWeight: '600', color: Colors.text,
  },
});
