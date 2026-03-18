import React from 'react';
import { Text, Linking, StyleSheet } from 'react-native';

const URL_REGEX = /(https?:\/\/[^\s<>"\])}]+)/gi;

interface LinkedTextProps {
  text: string;
  style?: any;
  linkColor?: string;
}

export function LinkedText({ text, style, linkColor = '#3B82F6' }: LinkedTextProps) {
  if (!text) return null;

  const parts = text.split(URL_REGEX);
  if (parts.length === 1) {
    return <Text style={style}>{text}</Text>;
  }

  return (
    <Text style={style}>
      {parts.map((part, i) => {
        if (URL_REGEX.test(part)) {
          // Reset lastIndex since we're using /g flag
          URL_REGEX.lastIndex = 0;
          return (
            <Text
              key={i}
              style={[styles.link, { color: linkColor }]}
              onPress={() => Linking.openURL(part)}
            >
              {part}
            </Text>
          );
        }
        return part;
      })}
    </Text>
  );
}

const styles = StyleSheet.create({
  link: {
    textDecorationLine: 'underline',
  },
});
