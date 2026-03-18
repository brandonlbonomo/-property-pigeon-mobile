import React, { useEffect, useState, useRef, useCallback } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TextInput, Image, Modal, Linking,
  TouchableOpacity, Platform, KeyboardAvoidingView,
  ActivityIndicator, Alert,
} from 'react-native';
import { useRoute, useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Colors, FontSize, Spacing, Radius } from '../../constants/theme';
import { useMessageStore, Message, Attachment } from '../../store/messageStore';
import { usePropertyRequestStore, ICalProperty } from '../../store/propertyRequestStore';
import { apiFetch } from '../../services/api';
import { LinkedText } from '../../components/LinkedText';
import { MediaBubble } from '../../components/MediaBubble';
import { PropertyRequestCard } from '../../components/PropertyRequestCard';
import { PropertyPickerModal } from '../../components/PropertyPickerModal';
import {
  pickImage, takePhoto, pickDocument,
  uploadAndGetAttachment, showAttachmentMenu,
} from '../../components/AttachmentPicker';

function formatTimeSeparator(ts: string): string {
  const d = new Date(ts);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  if (d.toDateString() === now.toDateString()) return time;

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`;

  const daysDiff = Math.floor((now.getTime() - d.getTime()) / 86400000);
  if (daysDiff < 7) {
    return d.toLocaleDateString('en-US', { weekday: 'long' }) + ' ' + time;
  }
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ', ' + time;
  }
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + ', ' + time;
}

function shouldShowTime(current: Message, previous?: Message): boolean {
  if (!previous) return true;
  return new Date(current.timestamp).getTime() - new Date(previous.timestamp).getTime() > 3600000;
}

function TimeSeparator({ timestamp }: { timestamp: string }) {
  return (
    <View style={styles.timeSeparator}>
      <Text style={styles.timeSeparatorText}>{formatTimeSeparator(timestamp)}</Text>
    </View>
  );
}

function HeaderTitle({ username, onPress }: { username: string; onPress?: () => void }) {
  const initial = (username || '?')[0].toUpperCase();
  return (
    <TouchableOpacity
      activeOpacity={0.7}
      onPress={onPress}
      disabled={!onPress}
      style={styles.headerTitleWrap}
    >
      <View style={styles.headerAvatar}>
        <Text style={styles.headerAvatarText}>{initial}</Text>
      </View>
      <Text style={styles.headerName}>{username}</Text>
    </TouchableOpacity>
  );
}

function MessageBubble({
  msg, isMine, showSender, receiptLabel,
}: {
  msg: Message; isMine: boolean; showSender?: boolean; receiptLabel?: string;
}) {
  const hasAttachments = msg.attachments && msg.attachments.length > 0;
  const hasText = !!msg.text;
  const linkColor = isMine ? 'rgba(255,255,255,0.9)' : '#3B82F6';

  return (
    <View style={[styles.bubbleRow, isMine && styles.bubbleRowMine]}>
      <View style={{ maxWidth: '75%' }}>
        <View style={[styles.bubble, isMine ? styles.bubbleMine : styles.bubbleTheirs]}>
          {showSender && !isMine && msg.sender_name ? (
            <Text style={styles.senderName}>{msg.sender_name}</Text>
          ) : null}
          {hasAttachments && msg.attachments!.map((att) => (
            <MediaBubble key={att.file_id} attachment={att} isMine={isMine} />
          ))}
          {hasText && (
            <LinkedText
              text={msg.text}
              style={[styles.bubbleText, isMine && styles.bubbleTextMine]}
              linkColor={linkColor}
            />
          )}
        </View>
        {receiptLabel ? (
          <Text style={styles.receiptText}>{receiptLabel}</Text>
        ) : null}
      </View>
    </View>
  );
}

function PendingAttachmentStrip({
  attachments,
  onRemove,
}: {
  attachments: Attachment[];
  onRemove: (index: number) => void;
}) {
  if (attachments.length === 0) return null;
  return (
    <ScrollView
      horizontal
      style={styles.pendingStrip}
      contentContainerStyle={styles.pendingStripContent}
      showsHorizontalScrollIndicator={false}
    >
      {attachments.map((att, i) => (
        <View key={att.file_id} style={styles.pendingItem}>
          {att.is_image ? (
            <Image
              source={{ uri: `https://portfoliopigeon.com${att.file_url}` }}
              style={styles.pendingThumb}
            />
          ) : (
            <View style={styles.pendingFileIcon}>
              <Ionicons name="document-outline" size={20} color={Colors.textSecondary} />
            </View>
          )}
          <TouchableOpacity
            activeOpacity={0.7}
            style={styles.pendingRemove}
            onPress={() => onRemove(i)}
          >
            <Ionicons name="close-circle" size={18} color={Colors.text} />
          </TouchableOpacity>
        </View>
      ))}
    </ScrollView>
  );
}

interface UserProfile {
  username: string;
  role: string;
  property_count: number;
  portfolio_score: number | null;
  plaid_verified_pct: number | null;
  avg_rating: number | null;
  rating_count: number;
}

interface CleaningEvent {
  check_in: string;
  check_out: string;
  prop_name: string;
  unit_name?: string;
  guest_name?: string;
}

function DetailsModal({
  visible,
  onClose,
  otherUserId,
  otherUsername,
  onInviteToProperties,
}: {
  visible: boolean;
  onClose: () => void;
  otherUserId: string;
  otherUsername: string;
  onInviteToProperties?: () => void;
}) {
  const { linkedProperties } = useMessageStore();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [events, setEvents] = useState<CleaningEvent[]>([]);
  const [loadingProfile, setLoadingProfile] = useState(true);
  const [loadingEvents, setLoadingEvents] = useState(true);
  const insets = useSafeAreaInsets();

  useEffect(() => {
    if (!visible || !otherUserId) return;
    setLoadingProfile(true);
    setLoadingEvents(true);
    apiFetch(`/api/users/profile/${otherUserId}`)
      .then((data) => setProfile(data))
      .catch(() => setProfile(null))
      .finally(() => setLoadingProfile(false));
    apiFetch(`/api/messages/cleanings/${otherUserId}`)
      .then((data) => setEvents(data.events || []))
      .catch(() => setEvents([]))
      .finally(() => setLoadingEvents(false));
  }, [visible, otherUserId]);

  const initial = ((profile?.username || otherUsername || '?')[0]).toUpperCase();
  const displayName = profile?.username || otherUsername;
  const role = profile?.role || 'owner';
  const roleLabel = role === 'cleaner' ? 'Cleaner' : 'Host';

  const formatDate = (d: string) => {
    if (!d) return '';
    const date = new Date(d + 'T12:00:00');
    return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  };

  const renderStars = (rating: number) => {
    const stars = [];
    for (let i = 1; i <= 5; i++) {
      stars.push(
        <Ionicons
          key={i}
          name={i <= Math.round(rating) ? 'star' : 'star-outline'}
          size={14}
          color={Colors.yellow}
        />
      );
    }
    return stars;
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={[styles.modalContainer, { paddingTop: insets.top + Spacing.sm }]}>
        <View style={styles.modalHeader}>
          <Text style={styles.modalTitle}>HQ</Text>
          <TouchableOpacity activeOpacity={0.7} onPress={onClose} style={styles.modalClose}>
            <Ionicons name="close-circle" size={28} color={Colors.textDim} />
          </TouchableOpacity>
        </View>

        {loadingProfile ? (
          <View style={styles.loadingWrap}>
            <ActivityIndicator color={Colors.primary} />
          </View>
        ) : (
          <ScrollView style={styles.modalScroll} contentContainerStyle={styles.modalContent}>
            {/* Profile card */}
            <View style={styles.detailProfileCard}>
              <View style={styles.detailAvatar}>
                <Text style={styles.detailAvatarText}>{initial}</Text>
              </View>
              <Text style={styles.detailUsername}>{displayName}</Text>
              <View style={styles.roleBadge}>
                <Ionicons
                  name={role === 'cleaner' ? 'sparkles' : 'home'}
                  size={11}
                  color={Colors.textSecondary}
                />
                <Text style={styles.roleBadgeText}>{roleLabel}</Text>
              </View>
            </View>

            {/* Stats row */}
            <View style={styles.statsRow}>
              {profile?.property_count != null && role !== 'cleaner' && (
                <View style={styles.statItem}>
                  <Text style={styles.statValue}>{profile.property_count}</Text>
                  <Text style={styles.statLabel}>Properties</Text>
                </View>
              )}
              {profile?.portfolio_score != null && (
                <View style={styles.statItem}>
                  <Text style={[styles.statValue, { color: profile.portfolio_score >= 70 ? Colors.green : profile.portfolio_score >= 40 ? Colors.yellow : Colors.red }]}>
                    {profile.portfolio_score}
                  </Text>
                  <Text style={styles.statLabel}>Score</Text>
                </View>
              )}
              {profile?.plaid_verified_pct != null && (
                <View style={styles.statItem}>
                  <Text style={styles.statValue}>{profile.plaid_verified_pct}%</Text>
                  <Text style={styles.statLabel}>Verified</Text>
                </View>
              )}
              {profile?.avg_rating != null && (
                <View style={styles.statItem}>
                  <View style={{ flexDirection: 'row', gap: 1 }}>{renderStars(profile.avg_rating)}</View>
                  <Text style={styles.statLabel}>{profile.avg_rating} ({profile.rating_count})</Text>
                </View>
              )}
            </View>

            {/* Linked properties */}
            {linkedProperties.length > 0 && (
              <View style={styles.detailSection}>
                <Text style={styles.detailSectionTitle}>Linked Properties</Text>
                {linkedProperties.map((p, i) => (
                  <View key={i} style={styles.linkedPropRow}>
                    <Ionicons name="home-outline" size={15} color={Colors.primary} />
                    <Text style={styles.linkedPropText}>{p}</Text>
                  </View>
                ))}
              </View>
            )}

            {/* Upcoming cleanings */}
            {linkedProperties.length > 0 && (
              <View style={styles.detailSection}>
                <Text style={styles.detailSectionTitle}>Upcoming Cleanings</Text>
                {loadingEvents ? (
                  <ActivityIndicator color={Colors.primary} style={{ marginTop: Spacing.md }} />
                ) : events.length === 0 ? (
                  <View style={styles.modalEmpty}>
                    <Ionicons name="calendar-outline" size={32} color={Colors.textDim} />
                    <Text style={styles.modalEmptyText}>No upcoming cleanings</Text>
                  </View>
                ) : (
                  events.map((ev, i) => (
                    <View key={i} style={styles.cleaningCard}>
                      <View style={styles.cleaningCardTop}>
                        <Ionicons name="home-outline" size={16} color={Colors.primary} />
                        <Text style={styles.cleaningProp} numberOfLines={1}>
                          {ev.prop_name}{ev.unit_name ? ` — ${ev.unit_name}` : ''}
                        </Text>
                      </View>
                      <View style={styles.cleaningDates}>
                        <View style={styles.cleaningDateCol}>
                          <Text style={styles.cleaningDateLabel}>Check-out</Text>
                          <Text style={styles.cleaningDateValue}>{formatDate(ev.check_out)}</Text>
                        </View>
                        <Ionicons name="arrow-forward" size={14} color={Colors.textDim} />
                        <View style={styles.cleaningDateCol}>
                          <Text style={styles.cleaningDateLabel}>Check-in</Text>
                          <Text style={styles.cleaningDateValue}>{formatDate(ev.check_in)}</Text>
                        </View>
                      </View>
                      {ev.guest_name ? (
                        <Text style={styles.cleaningGuest} numberOfLines={1}>
                          <Ionicons name="person-outline" size={11} color={Colors.textDim} /> {ev.guest_name}
                        </Text>
                      ) : null}
                    </View>
                  ))
                )}
              </View>
            )}

            {/* Invite to Properties button (host viewing cleaner) */}
            {onInviteToProperties && role === 'cleaner' && (
              <TouchableOpacity
                activeOpacity={0.7}
                style={styles.inviteBtn}
                onPress={() => {
                  onClose();
                  setTimeout(() => onInviteToProperties(), 300);
                }}
              >
                <Ionicons name="home-outline" size={18} color="#fff" />
                <Text style={styles.inviteBtnText}>Invite to Properties</Text>
              </TouchableOpacity>
            )}
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}

const URL_EXTRACT = /https?:\/\/[^\s<>")\]]+/gi;

interface InvoiceSummary {
  id: string;
  period: string;
  total: number;
  status: string;
  direction: 'sent' | 'received';
  createdAt: string;
}

function InfoModal({
  visible,
  onClose,
  otherUserId,
  messages,
}: {
  visible: boolean;
  onClose: () => void;
  otherUserId: string;
  messages: Message[];
}) {
  const [events, setEvents] = useState<CleaningEvent[]>([]);
  const [loadingEvents, setLoadingEvents] = useState(true);
  const [invoices, setInvoices] = useState<InvoiceSummary[]>([]);
  const [loadingInvoices, setLoadingInvoices] = useState(true);
  const insets = useSafeAreaInsets();

  // Collect all attachments from messages
  const allAttachments = messages.flatMap(m =>
    (m.attachments || []).map(a => ({ ...a, timestamp: m.timestamp }))
  );
  const images = allAttachments.filter(a => a.is_image);
  const files = allAttachments.filter(a => !a.is_image);

  // Extract all links from message text
  const links: string[] = [];
  messages.forEach(m => {
    if (m.text) {
      const found = m.text.match(URL_EXTRACT);
      if (found) links.push(...found);
    }
  });
  // Deduplicate
  const uniqueLinks = [...new Set(links)];

  useEffect(() => {
    if (!visible || !otherUserId) return;
    setLoadingEvents(true);
    setLoadingInvoices(true);
    apiFetch(`/api/messages/cleanings/${otherUserId}`)
      .then((data) => setEvents(data.events || []))
      .catch(() => setEvents([]))
      .finally(() => setLoadingEvents(false));
    apiFetch(`/api/invoices/between/${otherUserId}`)
      .then((data) => setInvoices(data.invoices || []))
      .catch(() => setInvoices([]))
      .finally(() => setLoadingInvoices(false));
  }, [visible, otherUserId]);

  const formatDate = (d: string) => {
    if (!d) return '';
    const date = new Date(d + 'T12:00:00');
    return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const InfoSection = ({ icon, iconColor, iconBg, title, count, children }: {
    icon: string; iconColor: string; iconBg: string; title: string; count?: number; children: React.ReactNode;
  }) => (
    <View style={styles.infoCard}>
      <View style={styles.infoCardHeader}>
        <View style={[styles.infoIconCircle, { backgroundColor: iconBg }]}>
          <Ionicons name={icon as any} size={15} color={iconColor} />
        </View>
        <Text style={styles.infoCardTitle}>{title}</Text>
        {count != null && count > 0 && (
          <View style={styles.infoCountBadge}>
            <Text style={styles.infoCountText}>{count}</Text>
          </View>
        )}
      </View>
      {children}
    </View>
  );

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={[styles.modalContainer, { paddingTop: insets.top + Spacing.sm }]}>
        <View style={styles.modalHeader}>
          <Text style={styles.modalTitle}>Info</Text>
          <TouchableOpacity activeOpacity={0.7} onPress={onClose} style={styles.modalClose}>
            <Ionicons name="close-circle" size={28} color={Colors.textDim} />
          </TouchableOpacity>
        </View>

        <ScrollView style={styles.modalScroll} contentContainerStyle={styles.modalContent}>
          {/* Photos */}
          <InfoSection icon="images-outline" iconColor="#8B5CF6" iconBg="rgba(139,92,246,0.10)" title="Photos" count={images.length}>
            {images.length === 0 ? (
              <View style={styles.infoEmptyRow}>
                <Ionicons name="image-outline" size={20} color={Colors.textDim} />
                <Text style={styles.infoEmptyText}>No photos shared yet</Text>
              </View>
            ) : (
              <View style={styles.photoGrid}>
                {images.map((img, i) => (
                  <TouchableOpacity
                    key={i}
                    activeOpacity={0.7}
                    onPress={() => Linking.openURL(`https://portfoliopigeon.com${img.file_url}`)}
                  >
                    <Image
                      source={{ uri: `https://portfoliopigeon.com${img.file_url}` }}
                      style={styles.gridThumb}
                    />
                  </TouchableOpacity>
                ))}
              </View>
            )}
          </InfoSection>

          {/* Files */}
          <InfoSection icon="document-outline" iconColor="#F59E0B" iconBg={Colors.yellowDim} title="Files" count={files.length}>
            {files.length === 0 ? (
              <View style={styles.infoEmptyRow}>
                <Ionicons name="folder-outline" size={20} color={Colors.textDim} />
                <Text style={styles.infoEmptyText}>No files shared yet</Text>
              </View>
            ) : (
              files.map((f, i) => (
                <TouchableOpacity
                  key={i}
                  activeOpacity={0.7}
                  style={styles.infoFileRow}
                  onPress={() => Linking.openURL(`https://portfoliopigeon.com${f.file_url}`)}
                >
                  <View style={[styles.infoFileIcon, { backgroundColor: Colors.yellowDim }]}>
                    <Ionicons name="document-text-outline" size={14} color="#F59E0B" />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.infoFileName} numberOfLines={1}>{f.filename}</Text>
                    <Text style={styles.infoFileSize}>{formatFileSize(f.size)}</Text>
                  </View>
                  <Ionicons name="open-outline" size={14} color={Colors.textDim} />
                </TouchableOpacity>
              ))
            )}
          </InfoSection>

          {/* Links */}
          <InfoSection icon="link-outline" iconColor="#3B82F6" iconBg="rgba(59,130,246,0.10)" title="Links" count={uniqueLinks.length}>
            {uniqueLinks.length === 0 ? (
              <View style={styles.infoEmptyRow}>
                <Ionicons name="globe-outline" size={20} color={Colors.textDim} />
                <Text style={styles.infoEmptyText}>No links shared yet</Text>
              </View>
            ) : (
              uniqueLinks.map((url, i) => (
                <TouchableOpacity
                  key={i}
                  activeOpacity={0.7}
                  style={styles.infoFileRow}
                  onPress={() => Linking.openURL(url)}
                >
                  <View style={[styles.infoFileIcon, { backgroundColor: 'rgba(59,130,246,0.10)' }]}>
                    <Ionicons name="globe-outline" size={14} color="#3B82F6" />
                  </View>
                  <Text style={[styles.infoFileName, { color: '#3B82F6', flex: 1 }]} numberOfLines={1}>{url}</Text>
                  <Ionicons name="open-outline" size={14} color={Colors.textDim} />
                </TouchableOpacity>
              ))
            )}
          </InfoSection>

          {/* Upcoming Cleanings */}
          <InfoSection icon="calendar-outline" iconColor={Colors.green} iconBg={Colors.greenDim} title="Upcoming Cleanings" count={events.length}>
            {loadingEvents ? (
              <ActivityIndicator color={Colors.primary} style={{ marginVertical: Spacing.md }} />
            ) : events.length === 0 ? (
              <View style={styles.infoEmptyRow}>
                <Ionicons name="calendar-outline" size={20} color={Colors.textDim} />
                <Text style={styles.infoEmptyText}>No upcoming cleanings</Text>
              </View>
            ) : (
              events.map((ev, i) => (
                <View key={i} style={styles.infoCleaningRow}>
                  <View style={[styles.infoFileIcon, { backgroundColor: Colors.greenDim }]}>
                    <Ionicons name="home-outline" size={14} color={Colors.green} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.infoFileName} numberOfLines={1}>
                      {ev.prop_name}{ev.unit_name ? ` — ${ev.unit_name}` : ''}
                    </Text>
                    <Text style={styles.infoFileSize}>
                      {formatDate(ev.check_out)} → {formatDate(ev.check_in)}
                    </Text>
                  </View>
                </View>
              ))
            )}
          </InfoSection>

          {/* Invoices */}
          <InfoSection icon="receipt-outline" iconColor="#EF4444" iconBg={Colors.redDim} title="Invoices" count={invoices.length}>
            {loadingInvoices ? (
              <ActivityIndicator color={Colors.primary} style={{ marginVertical: Spacing.md }} />
            ) : invoices.length === 0 ? (
              <View style={styles.infoEmptyRow}>
                <Ionicons name="receipt-outline" size={20} color={Colors.textDim} />
                <Text style={styles.infoEmptyText}>No invoices yet</Text>
              </View>
            ) : (
              invoices.map((inv) => {
                const statusColor = inv.status === 'paid' ? Colors.green : inv.status === 'sent' ? Colors.yellow : Colors.textDim;
                const statusBg = inv.status === 'paid' ? Colors.greenDim : inv.status === 'sent' ? Colors.yellowDim : Colors.glassDark;
                return (
                  <View key={inv.id} style={styles.invoiceRow}>
                    <View style={[styles.infoFileIcon, { backgroundColor: Colors.redDim }]}>
                      <Ionicons name="receipt-outline" size={14} color="#EF4444" />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.infoFileName}>{inv.period || 'Invoice'}</Text>
                      <Text style={styles.infoFileSize}>
                        {inv.direction === 'sent' ? 'Sent' : 'Received'}
                      </Text>
                    </View>
                    <View style={{ alignItems: 'flex-end', gap: 2 }}>
                      <Text style={[styles.invoiceAmount, { color: statusColor }]}>
                        ${(inv.total || 0).toFixed(2)}
                      </Text>
                      <View style={[styles.invoiceStatusPill, { backgroundColor: statusBg }]}>
                        <Text style={[styles.invoiceStatusText, { color: statusColor }]}>
                          {inv.status}
                        </Text>
                      </View>
                    </View>
                  </View>
                );
              })
            )}
          </InfoSection>
        </ScrollView>
      </View>
    </Modal>
  );
}

export function ChatScreen() {
  const route = useRoute<any>();
  const navigation = useNavigation<any>();
  const insets = useSafeAreaInsets();

  const { userId, username, convId, groupName } = route.params || {};
  const isGroup = !!(convId && convId.startsWith('grp_'));

  const {
    activeMessages, activeConversation, activeOtherUser, linkedProperties, loading,
    currentUserId: storeCurrentUserId,
    fetchMessages, fetchConvMessages,
    sendMessage, sendGroupMessage,
    markRead, markConvRead,
  } = useMessageStore();

  const { fetchHostICalProperties, createRequest, respondToRequest } = usePropertyRequestStore();

  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState<Attachment[]>([]);
  const [showProfile, setShowProfile] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [showInvitePicker, setShowInvitePicker] = useState(false);
  const [inviteProperties, setInviteProperties] = useState<ICalProperty[]>([]);
  const [inviteLoading, setInviteLoading] = useState(false);
  const [responding, setResponding] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastReceiptRef = useRef<{ msgId: string; status: string }>({ msgId: '', status: '' });

  const currentUserId = activeConversation?.current_user_id || storeCurrentUserId;
  const displayName = isGroup ? null : (activeOtherUser?.username || username || 'Chat');
  // Show details button when there are linked properties (cleaner-host relationship)
  const hasCleanerLink = !isGroup && linkedProperties.length > 0;

  // Update header whenever linked properties load
  useEffect(() => {
    const title = isGroup ? (groupName || 'Group Chat') : (activeOtherUser?.username || username || 'Chat');
    navigation.setOptions({
      headerTitle: () => (
        <HeaderTitle
          username={title}
          onPress={!isGroup ? () => setShowProfile(true) : undefined}
        />
      ),
      headerLeft: () => (
        <TouchableOpacity
          activeOpacity={0.7}
          onPress={() => navigation.goBack()}
          style={{ padding: 4, marginRight: Spacing.sm }}
        >
          <Ionicons name="chevron-back" size={24} color={Colors.text} />
        </TouchableOpacity>
      ),
      headerRight: !isGroup ? () => (
        <TouchableOpacity
          activeOpacity={0.7}
          onPress={() => setShowInfo(true)}
          style={styles.headerInfoBtn}
        >
          <Ionicons name="information-circle-outline" size={22} color={Colors.primary} />
        </TouchableOpacity>
      ) : undefined,
    });
  }, [isGroup, groupName, username, activeOtherUser?.username]);

  useEffect(() => {
    if (isGroup) {
      fetchConvMessages(convId);
      markConvRead(convId);
      pollRef.current = setInterval(() => {
        fetchConvMessages(convId);
        markConvRead(convId);
      }, 5000);
    } else {
      fetchMessages(userId);
      markRead(userId);
      pollRef.current = setInterval(() => {
        fetchMessages(userId);
        markRead(userId);
      }, 5000);
    }

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [isGroup ? convId : userId]);

  useEffect(() => {
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
  }, [activeMessages.length]);

  const handleAttachmentPick = useCallback(async (
    picker: () => Promise<any>,
    isImagePicker: boolean,
  ) => {
    const result = await picker();
    if (!result || result.canceled) return;

    setUploading(true);
    try {
      if (isImagePicker) {
        const asset = result.assets[0];
        const uri = asset.uri;
        const filename = asset.fileName || uri.split('/').pop() || 'image.jpg';
        const mimeType = asset.mimeType || 'image/jpeg';
        const att = await uploadAndGetAttachment(uri, filename, mimeType);
        setPendingAttachments(prev => [...prev, att]);
      } else {
        // Document picker
        if (result.canceled) return;
        const asset = result.assets[0];
        const att = await uploadAndGetAttachment(
          asset.uri,
          asset.name || 'document',
          asset.mimeType || 'application/octet-stream',
        );
        setPendingAttachments(prev => [...prev, att]);
      }
    } catch (err: any) {
      Alert.alert('Upload Failed', err.message || 'Could not upload file.');
    } finally {
      setUploading(false);
    }
  }, []);

  const handleShowMenu = useCallback(() => {
    showAttachmentMenu(
      () => handleAttachmentPick(pickImage, true),
      () => handleAttachmentPick(takePhoto, true),
      () => handleAttachmentPick(pickDocument, false),
    );
  }, [handleAttachmentPick]);

  const canSend = text.trim() || pendingAttachments.length > 0;

  const handleSend = useCallback(async () => {
    const trimmed = text.trim();
    if ((!trimmed && pendingAttachments.length === 0) || sending) return;

    setSending(true);
    const savedText = text;
    const savedAttachments = [...pendingAttachments];
    setText('');
    setPendingAttachments([]);

    let result;
    const atts = savedAttachments.length > 0 ? savedAttachments : undefined;
    if (isGroup) {
      result = await sendGroupMessage(convId, trimmed, atts);
    } else {
      result = await sendMessage(userId, trimmed, atts);
    }
    if (!result) {
      setText(savedText);
      setPendingAttachments(savedAttachments);
      Alert.alert('Send Failed', 'Could not send message. Please try again.');
    }
    setSending(false);
    scrollRef.current?.scrollToEnd({ animated: true });
  }, [text, pendingAttachments, isGroup, convId, userId, sending, sendMessage, sendGroupMessage]);

  const checkIsMine = (msg: Message) => {
    if (isGroup && currentUserId) {
      return msg.sender_id === currentUserId;
    }
    return msg.sender_id !== userId;
  };

  const handleRespondToRequest = useCallback(async (requestId: string, action: 'approve' | 'deny') => {
    setResponding(true);
    const res = await respondToRequest(requestId, action);
    setResponding(false);
    if (res.ok) {
      // Re-fetch to get updated system message
      if (isGroup) fetchConvMessages(convId);
      else fetchMessages(userId);
    } else {
      Alert.alert('Error', res.error || 'Could not respond to request.');
    }
  }, [respondToRequest, isGroup, convId, userId, fetchConvMessages, fetchMessages]);

  const handleOpenInvitePicker = useCallback(async () => {
    setInviteLoading(true);
    const props = await fetchHostICalProperties();
    setInviteProperties(props);
    setInviteLoading(false);
    setShowInvitePicker(true);
  }, [fetchHostICalProperties]);

  const handleInviteSubmit = useCallback(async (propertyIds: string[], feedKeys: string[]) => {
    setInviteLoading(true);
    const res = await createRequest(userId, propertyIds, 'invite', feedKeys);
    setInviteLoading(false);
    if (res.ok) {
      setShowInvitePicker(false);
      Alert.alert('Invite Sent', 'Property invite sent. They will be notified.');
      // Re-fetch messages to show new system card
      fetchMessages(userId);
    } else {
      Alert.alert('Error', res.error || 'Could not send invite.');
    }
  }, [createRequest, userId, fetchMessages]);

  const emptyLabel = isGroup
    ? `Start the conversation in ${groupName || 'this group'}!`
    : `Say hello to ${username}!`;

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
    >
      {loading && activeMessages.length === 0 ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator color={Colors.primary} />
        </View>
      ) : (
        <ScrollView
          ref={scrollRef}
          style={styles.messageList}
          contentContainerStyle={styles.messageContent}
          keyboardDismissMode="interactive"
        >
          {activeMessages.length === 0 && (
            <View style={styles.emptyChat}>
              <Text style={styles.emptyChatText}>{emptyLabel}</Text>
            </View>
          )}
          {(() => {
            // Compute receipt for last sent message (prevents flicker with ref)
            const lastMine = [...activeMessages].reverse().find(m => checkIsMine(m));
            if (lastMine) {
              if (lastMine.id !== lastReceiptRef.current.msgId) {
                lastReceiptRef.current = { msgId: lastMine.id, status: 'Delivered' };
              }
              const isRead = lastMine.read || (lastMine.read_by && lastMine.read_by.length > 1);
              if (isRead) lastReceiptRef.current.status = 'Read';
            }

            return activeMessages.map((msg, idx) => {
              const isMine = checkIsMine(msg);
              const isLastMine = lastMine && msg.id === lastMine.id;
              const showTime = shouldShowTime(msg, activeMessages[idx - 1]);

              // System messages (property requests/invites)
              if (msg.system && msg.system_data) {
                return (
                  <React.Fragment key={msg.id}>
                    {showTime && <TimeSeparator timestamp={msg.timestamp} />}
                    <PropertyRequestCard
                      systemData={msg.system_data}
                      currentUserId={currentUserId}
                      onRespond={handleRespondToRequest}
                      responding={responding}
                    />
                  </React.Fragment>
                );
              }

              return (
                <React.Fragment key={msg.id}>
                  {showTime && <TimeSeparator timestamp={msg.timestamp} />}
                  <MessageBubble
                    msg={msg}
                    isMine={isMine}
                    showSender={isGroup}
                    receiptLabel={isLastMine ? lastReceiptRef.current.status : undefined}
                  />
                </React.Fragment>
              );
            });
          })()}
        </ScrollView>
      )}

      {/* Pending attachments strip */}
      <PendingAttachmentStrip
        attachments={pendingAttachments}
        onRemove={(i) => setPendingAttachments(prev => prev.filter((_, idx) => idx !== i))}
      />

      {/* Input bar */}
      <View style={[styles.inputBar, { paddingBottom: Math.max(insets.bottom, Spacing.sm) }]}>
        <TouchableOpacity
          activeOpacity={0.7}
          style={styles.attachBtn}
          onPress={handleShowMenu}
          disabled={uploading}
        >
          {uploading ? (
            <ActivityIndicator color={Colors.primary} size="small" />
          ) : (
            <Ionicons name="add-circle-outline" size={28} color={Colors.primary} />
          )}
        </TouchableOpacity>
        <TextInput
          style={styles.input}
          value={text}
          onChangeText={setText}
          placeholder="Message..."
          placeholderTextColor={Colors.textDim}
          multiline
          maxLength={2000}
          returnKeyType="default"
        />
        <TouchableOpacity
          activeOpacity={0.7}
          style={[styles.sendBtn, !canSend && styles.sendBtnDisabled]}
          onPress={handleSend}
          disabled={!canSend || sending}
        >
          {sending ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <Ionicons name="send" size={18} color="#fff" />
          )}
        </TouchableOpacity>
      </View>

      {/* Profile modal */}
      {!isGroup && (
        <DetailsModal
          visible={showProfile}
          onClose={() => setShowProfile(false)}
          otherUserId={userId}
          otherUsername={displayName || ''}
          onInviteToProperties={handleOpenInvitePicker}
        />
      )}

      {/* Info modal — shared files, cleanings, invoices */}
      {!isGroup && (
        <InfoModal
          visible={showInfo}
          onClose={() => setShowInfo(false)}
          otherUserId={userId}
          messages={activeMessages}
        />
      )}

      {/* Property invite picker */}
      {!isGroup && (
        <PropertyPickerModal
          visible={showInvitePicker}
          onClose={() => setShowInvitePicker(false)}
          properties={inviteProperties}
          currentlySelected={[]}
          actionLabel="Send Invite"
          onSubmit={handleInviteSubmit}
          loading={inviteLoading}
        />
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  loadingWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  messageList: { flex: 1 },
  messageContent: { padding: Spacing.md, paddingBottom: Spacing.sm },

  // Header title with avatar
  headerTitleWrap: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 1,
  },
  headerAvatar: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: Colors.glass,
    borderWidth: 0.5,
    borderColor: Colors.glassBorder,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerAvatarText: {
    fontSize: 12,
    fontWeight: '700',
    color: Colors.text,
  },
  headerName: {
    fontSize: 11,
    fontWeight: '600',
    color: Colors.text,
  },
  headerInfoBtn: {
    width: 30,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
  },

  emptyChat: {
    alignItems: 'center', paddingVertical: Spacing.xl * 2,
  },
  emptyChatText: { fontSize: FontSize.sm, color: Colors.textDim },

  bubbleRow: {
    flexDirection: 'row', marginBottom: Spacing.xs,
  },
  bubbleRowMine: {
    justifyContent: 'flex-end',
  },
  bubble: {
    minWidth: 60,
    paddingHorizontal: Spacing.sm + 2,
    paddingVertical: Spacing.sm,
    borderRadius: Radius.lg,
  },
  bubbleMine: {
    backgroundColor: Colors.primary,
    borderBottomRightRadius: 4,
  },
  bubbleTheirs: {
    backgroundColor: Colors.glassHeavy,
    borderWidth: 0.5,
    borderColor: Colors.glassBorder,
    borderBottomLeftRadius: 4,
    ...Platform.select({
      ios: {
        shadowColor: Colors.glassShadow,
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.2,
        shadowRadius: 6,
      },
    }),
  },
  senderName: {
    fontSize: 11,
    fontWeight: '600',
    color: Colors.green,
    marginBottom: 2,
  },
  bubbleText: { fontSize: FontSize.md, color: Colors.text, lineHeight: 19 },
  bubbleTextMine: { color: '#fff' },

  // iMessage-style time separators
  timeSeparator: {
    alignItems: 'center',
    paddingVertical: Spacing.sm,
    marginTop: Spacing.xs,
  },
  timeSeparatorText: {
    fontSize: 11,
    fontWeight: '500',
    color: Colors.textDim,
  },

  // Pending attachments
  pendingStrip: {
    maxHeight: 72,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.border,
    backgroundColor: Colors.bg,
  },
  pendingStripContent: {
    padding: Spacing.sm,
    gap: Spacing.sm,
  },
  pendingItem: {
    position: 'relative',
  },
  pendingThumb: {
    width: 56,
    height: 56,
    borderRadius: Radius.sm,
    resizeMode: 'cover',
  },
  pendingFileIcon: {
    width: 56,
    height: 56,
    borderRadius: Radius.sm,
    backgroundColor: Colors.glassDark,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pendingRemove: {
    position: 'absolute',
    top: -4,
    right: -4,
    backgroundColor: Colors.bg,
    borderRadius: 9,
  },

  // Input bar
  inputBar: {
    flexDirection: 'row', alignItems: 'flex-end', gap: Spacing.sm,
    paddingHorizontal: Spacing.md, paddingTop: Spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Colors.border,
    backgroundColor: Colors.bg,
  },
  attachBtn: {
    width: 36, height: 36,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: Platform.OS === 'ios' ? 1 : 0,
  },
  input: {
    flex: 1,
    backgroundColor: Colors.glassHeavy,
    borderWidth: 0.5,
    borderColor: Colors.glassBorder,
    borderRadius: Radius.lg,
    paddingHorizontal: Spacing.md,
    paddingVertical: Platform.OS === 'ios' ? 10 : 8,
    fontSize: FontSize.md,
    color: Colors.text,
    maxHeight: 100,
  },
  sendBtn: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: Colors.primary,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: Platform.OS === 'ios' ? 1 : 0,
  },
  sendBtnDisabled: { opacity: 0.4 },

  // Details modal
  modalContainer: {
    flex: 1,
    backgroundColor: Colors.bg,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.md,
    paddingBottom: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
  },
  modalTitle: {
    fontSize: FontSize.lg,
    fontWeight: '700',
    color: Colors.text,
    flex: 1,
    textAlign: 'center',
  },
  modalClose: {
    position: 'absolute',
    right: Spacing.md,
    padding: 2,
  },
  modalScroll: {
    flex: 1,
  },
  modalContent: {
    padding: Spacing.md,
    paddingBottom: Spacing.xl,
  },
  detailProfileCard: {
    alignItems: 'center',
    paddingVertical: Spacing.lg,
    marginBottom: Spacing.md,
  },
  detailAvatar: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: Colors.glass,
    borderWidth: 1,
    borderColor: Colors.glassBorder,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.sm,
  },
  detailAvatarText: {
    fontSize: FontSize.lg,
    fontWeight: '700',
    color: Colors.text,
  },
  detailUsername: {
    fontSize: FontSize.md,
    fontWeight: '600',
    color: Colors.text,
  },
  detailProps: {
    fontSize: FontSize.xs,
    color: Colors.textSecondary,
    marginTop: 3,
    textAlign: 'center',
  },
  detailSectionTitle: {
    fontSize: FontSize.sm,
    fontWeight: '700',
    color: Colors.text,
    marginBottom: Spacing.sm,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  modalEmpty: {
    alignItems: 'center',
    paddingVertical: Spacing.xl,
  },
  modalEmptyText: {
    fontSize: FontSize.sm,
    color: Colors.textDim,
    marginTop: Spacing.sm,
  },
  cleaningCard: {
    backgroundColor: Colors.glass,
    borderWidth: 1,
    borderColor: Colors.glassBorder,
    borderTopWidth: 1.5,
    borderTopColor: Colors.glassHighlight,
    borderRadius: Radius.xl,
    padding: Spacing.md,
    marginBottom: Spacing.sm,
    ...Platform.select({
      ios: {
        shadowColor: Colors.glassShadow,
        shadowOffset: { width: 0, height: 3 },
        shadowOpacity: 0.2,
        shadowRadius: 8,
      },
    }),
  },
  cleaningCardTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    marginBottom: Spacing.sm,
  },
  cleaningProp: {
    fontSize: FontSize.md,
    fontWeight: '600',
    color: Colors.text,
    flex: 1,
  },
  cleaningDates: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
  },
  cleaningDateCol: {
    flex: 1,
  },
  cleaningDateLabel: {
    fontSize: 11,
    color: Colors.textDim,
    marginBottom: 2,
  },
  cleaningDateValue: {
    fontSize: FontSize.xs,
    fontWeight: '600',
    color: Colors.text,
  },
  cleaningGuest: {
    fontSize: FontSize.xs,
    color: Colors.textSecondary,
    marginTop: Spacing.sm,
  },

  // Profile modal extras
  roleBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 4,
    backgroundColor: Colors.glassDark,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 3,
    borderRadius: Radius.pill,
  },
  roleBadgeText: {
    fontSize: 11,
    fontWeight: '600',
    color: Colors.textSecondary,
  },
  statsRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: Spacing.lg,
    paddingVertical: Spacing.md,
    marginBottom: Spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
  },
  statItem: {
    alignItems: 'center',
    gap: 2,
  },
  statValue: {
    fontSize: FontSize.lg,
    fontWeight: '700',
    color: Colors.text,
  },
  statLabel: {
    fontSize: 11,
    color: Colors.textDim,
  },
  detailSection: {
    marginBottom: Spacing.lg,
  },
  linkedPropRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
  },
  linkedPropText: {
    fontSize: FontSize.xs,
    color: Colors.text,
    flex: 1,
  },


  // Info modal — Liquid Glass cards
  infoCard: {
    backgroundColor: Colors.glass,
    borderRadius: Radius.xl,
    borderWidth: 0.5,
    borderColor: Colors.glassBorder,
    borderTopWidth: 1.5,
    borderTopColor: Colors.glassHighlight,
    padding: Spacing.md,
    marginBottom: Spacing.sm,
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
  infoCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    marginBottom: Spacing.sm,
  },
  infoIconCircle: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  infoCardTitle: {
    fontSize: FontSize.xs,
    fontWeight: '700',
    color: Colors.text,
    flex: 1,
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  infoCountBadge: {
    backgroundColor: Colors.glassDark,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: Radius.pill,
  },
  infoCountText: {
    fontSize: 11,
    fontWeight: '600',
    color: Colors.textSecondary,
  },
  infoEmptyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingVertical: Spacing.sm,
  },
  infoEmptyText: {
    fontSize: FontSize.xs,
    color: Colors.textDim,
  },
  photoGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
  },
  gridThumb: {
    width: 72,
    height: 72,
    borderRadius: Radius.md,
    resizeMode: 'cover',
  },
  infoFileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingVertical: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
  },
  infoFileIcon: {
    width: 28,
    height: 28,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  infoFileName: {
    fontSize: FontSize.xs,
    fontWeight: '500',
    color: Colors.text,
  },
  infoFileSize: {
    fontSize: 11,
    color: Colors.textDim,
    marginTop: 1,
  },
  infoCleaningRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingVertical: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
  },
  receiptText: {
    fontSize: 10,
    color: Colors.textDim,
    textAlign: 'right',
    marginTop: 2,
    marginRight: 2,
  },

  // Invoice rows in InfoModal
  invoiceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingVertical: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
  },
  invoiceAmount: {
    fontSize: FontSize.sm,
    fontWeight: '700',
  },
  invoiceStatusPill: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: Radius.pill,
  },
  invoiceStatusText: {
    fontSize: 10,
    fontWeight: '600',
    textTransform: 'capitalize',
  },

  // Invite button in DetailsModal
  inviteBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    backgroundColor: Colors.green,
    paddingVertical: Spacing.md,
    borderRadius: Radius.md,
    marginTop: Spacing.sm,
  },
  inviteBtnText: {
    fontSize: FontSize.md,
    fontWeight: '600',
    color: '#fff',
  },
});
