import React from 'react';
import { View, Text, Image, TouchableOpacity, Linking, StyleSheet } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { API_BASE } from '../constants/api';
import { Colors, FontSize, Spacing, Radius } from '../constants/theme';
import type { Attachment } from '../store/messageStore';

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface MediaBubbleProps {
  attachment: Attachment;
  isMine?: boolean;
}

export function MediaBubble({ attachment, isMine }: MediaBubbleProps) {
  const fullUrl = `${API_BASE}${attachment.file_url}`;

  if (attachment.is_image) {
    return (
      <TouchableOpacity
        activeOpacity={0.7}
        onPress={() => Linking.openURL(fullUrl)}
        style={styles.imageWrap}
      >
        <Image source={{ uri: fullUrl }} style={styles.image} />
      </TouchableOpacity>
    );
  }

  // File card
  return (
    <TouchableOpacity
      activeOpacity={0.7}
      onPress={() => Linking.openURL(fullUrl)}
      style={[styles.fileCard, isMine && styles.fileCardMine]}
    >
      <View style={[styles.fileIcon, isMine && styles.fileIconMine]}>
        <Ionicons name="document-outline" size={20} color={isMine ? '#fff' : Colors.primary} />
      </View>
      <View style={styles.fileInfo}>
        <Text
          style={[styles.fileName, isMine && styles.fileNameMine]}
          numberOfLines={1}
        >
          {attachment.filename}
        </Text>
        <Text style={[styles.fileSize, isMine && styles.fileSizeMine]}>
          {formatFileSize(attachment.size)}
        </Text>
      </View>
      <Ionicons
        name="download-outline"
        size={18}
        color={isMine ? 'rgba(255,255,255,0.6)' : Colors.textDim}
      />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  imageWrap: {
    marginBottom: 4,
    borderRadius: Radius.md,
    overflow: 'hidden',
  },
  image: {
    width: 200,
    height: 200,
    borderRadius: Radius.md,
    resizeMode: 'cover',
  },
  fileCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    backgroundColor: 'rgba(0,0,0,0.04)',
    borderRadius: Radius.sm,
    padding: Spacing.sm,
    marginBottom: 4,
  },
  fileCardMine: {
    backgroundColor: 'rgba(255,255,255,0.15)',
  },
  fileIcon: {
    width: 36,
    height: 36,
    borderRadius: Radius.sm,
    backgroundColor: Colors.greenDim,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fileIconMine: {
    backgroundColor: 'rgba(255,255,255,0.2)',
  },
  fileInfo: {
    flex: 1,
  },
  fileName: {
    fontSize: FontSize.xs,
    fontWeight: '500',
    color: Colors.text,
  },
  fileNameMine: {
    color: '#fff',
  },
  fileSize: {
    fontSize: 11,
    color: Colors.textDim,
    marginTop: 1,
  },
  fileSizeMine: {
    color: 'rgba(255,255,255,0.6)',
  },
});
