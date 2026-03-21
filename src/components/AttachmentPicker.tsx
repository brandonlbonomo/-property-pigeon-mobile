import { ActionSheetIOS, Platform, Alert } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { apiUploadFile } from '../services/api';
import type { Attachment } from '../store/messageStore';
import { glassAlert } from './GlassAlert';

export async function pickImage(): Promise<ImagePicker.ImagePickerResult | null> {
  const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (status !== 'granted') {
    glassAlert('Permission Required', 'Please allow access to your photo library in Settings.');
    return null;
  }
  return ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    quality: 0.8,
  });
}

export async function takePhoto(): Promise<ImagePicker.ImagePickerResult | null> {
  const { status } = await ImagePicker.requestCameraPermissionsAsync();
  if (status !== 'granted') {
    glassAlert('Permission Required', 'Please allow camera access in Settings.');
    return null;
  }
  return ImagePicker.launchCameraAsync({
    quality: 0.8,
  });
}

export async function pickDocument(): Promise<DocumentPicker.DocumentPickerResult | null> {
  return DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
}

export async function uploadAndGetAttachment(
  uri: string,
  filename: string,
  mimeType: string,
): Promise<Attachment> {
  const result = await apiUploadFile(uri, filename, mimeType);
  return {
    file_id: result.file_id,
    filename: result.filename,
    file_url: result.file_url,
    mime_type: result.mime_type,
    size: result.size,
    is_image: result.is_image,
  };
}

export function showAttachmentMenu(
  onPickImage: () => void,
  onTakePhoto: () => void,
  onPickDocument: () => void,
) {
  if (Platform.OS === 'ios') {
    ActionSheetIOS.showActionSheetWithOptions(
      {
        options: ['Cancel', 'Photo Library', 'Take Photo', 'Document'],
        cancelButtonIndex: 0,
      },
      (index) => {
        if (index === 1) onPickImage();
        else if (index === 2) onTakePhoto();
        else if (index === 3) onPickDocument();
      },
    );
  } else {
    // Android fallback — use Alert as simple menu
    glassAlert('Attach', 'Choose an option', [
      { text: 'Photo Library', onPress: onPickImage },
      { text: 'Take Photo', onPress: onTakePhoto },
      { text: 'Document', onPress: onPickDocument },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }
}
