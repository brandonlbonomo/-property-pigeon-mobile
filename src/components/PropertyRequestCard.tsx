import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform, ActivityIndicator } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Colors, FontSize, Spacing, Radius } from '../constants/theme';
import { SystemData } from '../store/messageStore';

interface Props {
  systemData: SystemData;
  currentUserId: string | null | undefined;
  onRespond: (requestId: string, action: 'approve' | 'deny') => void;
  responding?: boolean;
}

export function PropertyRequestCard({ systemData, currentUserId, onRespond, responding }: Props) {
  const isRequest = systemData.type === 'property_request';
  const isTarget = currentUserId === systemData.target_id;
  const isPending = systemData.status === 'pending';

  const headerIcon = isRequest ? 'key-outline' : 'mail-outline';
  const headerText = isRequest ? 'Property Access Request' : 'Property Invite';

  const description = isRequest
    ? `${systemData.requester_name} requested access to:`
    : `${systemData.requester_name} invited you to:`;

  const statusColor = systemData.status === 'approved'
    ? Colors.green
    : systemData.status === 'denied'
      ? Colors.red
      : Colors.yellow;

  const statusBg = systemData.status === 'approved'
    ? Colors.greenDim
    : systemData.status === 'denied'
      ? Colors.redDim
      : Colors.yellowDim;

  return (
    <View style={styles.container}>
      <View style={styles.card}>
        {/* Header */}
        <View style={styles.header}>
          <View style={[styles.iconCircle, { backgroundColor: isRequest ? Colors.primaryDim : Colors.greenDim }]}>
            <Ionicons name={headerIcon as any} size={16} color={isRequest ? Colors.primary : Colors.green} />
          </View>
          <Text style={styles.headerText}>{headerText}</Text>
        </View>

        {/* Description */}
        <Text style={styles.description}>{description}</Text>

        {/* Property list */}
        <View style={styles.propList}>
          {systemData.property_labels.map((label, i) => (
            <View key={i} style={styles.propItem}>
              <Ionicons name="home-outline" size={14} color={Colors.primary} />
              <Text style={styles.propLabel}>{label}</Text>
            </View>
          ))}
        </View>

        {/* Status pill */}
        <View style={styles.statusRow}>
          <View style={[styles.statusPill, { backgroundColor: statusBg }]}>
            <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
            <Text style={[styles.statusText, { color: statusColor }]}>
              {systemData.status.charAt(0).toUpperCase() + systemData.status.slice(1)}
            </Text>
          </View>
        </View>

        {/* Action buttons (only for target, only when pending) */}
        {isTarget && isPending && (
          <View style={styles.actions}>
            <TouchableOpacity
              activeOpacity={0.7}
              style={[styles.actionBtn, styles.denyBtn]}
              onPress={() => onRespond(systemData.request_id, 'deny')}
              disabled={responding}
            >
              <Text style={styles.denyText}>Deny</Text>
            </TouchableOpacity>
            <TouchableOpacity
              activeOpacity={0.7}
              style={[styles.actionBtn, styles.approveBtn]}
              onPress={() => onRespond(systemData.request_id, 'approve')}
              disabled={responding}
            >
              {responding ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <Text style={styles.approveText}>Approve</Text>
              )}
            </TouchableOpacity>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    marginVertical: Spacing.sm,
    paddingHorizontal: Spacing.md,
  },
  card: {
    width: '100%',
    maxWidth: 320,
    backgroundColor: Colors.glass,
    borderRadius: Radius.xl,
    borderWidth: 0.5,
    borderColor: Colors.glassBorder,
    borderTopWidth: 1.5,
    borderTopColor: Colors.glassHighlight,
    padding: Spacing.md,
    overflow: 'hidden',
    ...Platform.select({
      ios: {
        shadowColor: Colors.glassShadow,
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.25,
        shadowRadius: 12,
      },
      android: { elevation: 3 },
    }),
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    marginBottom: Spacing.sm,
  },
  iconCircle: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerText: {
    fontSize: FontSize.sm,
    fontWeight: '700',
    color: Colors.text,
  },
  description: {
    fontSize: FontSize.xs,
    color: Colors.textSecondary,
    marginBottom: Spacing.sm,
    lineHeight: 18,
  },
  propList: {
    gap: 4,
    marginBottom: Spacing.sm,
  },
  propItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 3,
  },
  propLabel: {
    fontSize: FontSize.xs,
    fontWeight: '500',
    color: Colors.text,
  },
  statusRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    marginBottom: Spacing.xs,
  },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: Spacing.sm + 2,
    paddingVertical: 4,
    borderRadius: Radius.pill,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  statusText: {
    fontSize: 11,
    fontWeight: '600',
  },
  actions: {
    flexDirection: 'row',
    gap: Spacing.sm,
    marginTop: Spacing.sm,
  },
  actionBtn: {
    flex: 1,
    paddingVertical: Spacing.sm,
    borderRadius: Radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  denyBtn: {
    backgroundColor: Colors.redDim,
    borderWidth: 1,
    borderColor: 'rgba(239,68,68,0.20)',
  },
  approveBtn: {
    backgroundColor: Colors.green,
  },
  denyText: {
    fontSize: FontSize.xs,
    fontWeight: '600',
    color: Colors.red,
  },
  approveText: {
    fontSize: FontSize.xs,
    fontWeight: '600',
    color: '#fff',
  },
});
