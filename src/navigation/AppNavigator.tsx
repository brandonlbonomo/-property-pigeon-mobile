import React from 'react';
import { View, Text, Image, StyleSheet, TouchableOpacity } from 'react-native';
import { NavigationContainer, useNavigation } from '@react-navigation/native';
import { navigationRef } from './navigationRef';
import { ProPaywallScreen } from '../components/ProPaywallModal';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import Ionicons from '@expo/vector-icons/Ionicons';

import { Colors, Radius } from '../constants/theme';
import { SettingsScreen } from '../screens/settings/SettingsScreen';
import { NotificationsScreen } from '../screens/notifications/NotificationsScreen';
import { SearchScreen } from '../screens/search/SearchScreen';
import { ConversationsScreen } from '../screens/messages/ConversationsScreen';
import { ChatScreen } from '../screens/messages/ChatScreen';
import { ComposeMessageScreen } from '../screens/messages/ComposeMessageScreen';
import { ComposeGroupScreen } from '../screens/messages/ComposeGroupScreen';
import { PillNavigator } from './LTRNavigator';

const RootStack = createNativeStackNavigator();

// ── Shared header components (used by both TabNavigator and LTRNavigator) ──

export function HeaderLeft() {
  const navigation = useNavigation<any>();
  return (
    <TouchableOpacity activeOpacity={0.7}
          onPress={() => navigation.navigate('Settings')}
      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
      style={{ marginLeft: 4 }}
    >
      <Ionicons name="settings-outline" size={22} color={Colors.textSecondary} />
    </TouchableOpacity>
  );
}

export function HeaderRight() {
  const navigation = useNavigation<any>();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, marginRight: 4 }}>
      <TouchableOpacity activeOpacity={0.7}
          onPress={() => navigation.navigate('Search')}
        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
      >
        <Ionicons name="search-outline" size={22} color={Colors.textSecondary} />
      </TouchableOpacity>
      <TouchableOpacity activeOpacity={0.7}
          onPress={() => navigation.navigate('Conversations')}
        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
      >
        <Ionicons name="chatbubble-outline" size={20} color={Colors.textSecondary} />
      </TouchableOpacity>
      <TouchableOpacity activeOpacity={0.7}
          onPress={() => navigation.navigate('Notifications')}
        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
      >
        <Ionicons name="notifications-outline" size={22} color={Colors.textSecondary} />
      </TouchableOpacity>
    </View>
  );
}

export function CustomHeaderTitle() {
  return (
    <Image source={require('../../assets/logo.png')} style={headerStyles.logo} />
  );
}

export const headerStyles = StyleSheet.create({
  logo: {
    width: 32,
    height: 32,
    resizeMode: 'contain',
  },
});

export const screenOpts = {
  headerStyle: { backgroundColor: Colors.bg },
  headerTintColor: Colors.text,
  headerTitleStyle: { color: Colors.text, fontWeight: '600' as const },
  headerShadowVisible: false,
  headerTitle: () => <CustomHeaderTitle />,
  headerLeft: () => <HeaderLeft />,
  headerRight: () => <HeaderRight />,
};

function MainScreen() {
  return <PillNavigator />;
}

export function AppNavigator() {
  return (
    <NavigationContainer ref={navigationRef}>
      <RootStack.Navigator>
        <RootStack.Screen
          name="Main"
          component={MainScreen}
          options={{
            headerShown: false,
          }}
        />
        <RootStack.Screen
          name="Settings"
          component={SettingsScreen}
          options={{
            presentation: 'modal',
            headerTitle: 'Settings',
            headerStyle: { backgroundColor: Colors.bg },
            contentStyle: { backgroundColor: Colors.bg },
            headerTintColor: Colors.text,
            headerTitleStyle: { fontWeight: '600', color: Colors.text },
            headerShadowVisible: false,
            headerLeft: () => null,
            headerRight: () => {
              const navigation = useNavigation<any>();
              return (
                <TouchableOpacity activeOpacity={0.7}
          onPress={() => navigation.goBack()}>
                  <Text style={{ color: Colors.primary, fontSize: 16, fontWeight: '500' }}>Done</Text>
                </TouchableOpacity>
              );
            },
          }}
        />
        <RootStack.Screen
          name="Notifications"
          component={NotificationsScreen}
          options={{
            presentation: 'modal',
            headerTitle: 'Notifications',
            headerStyle: { backgroundColor: Colors.bg },
            contentStyle: { backgroundColor: Colors.bg },
            headerTintColor: Colors.text,
            headerTitleStyle: { fontWeight: '600', color: Colors.text },
            headerShadowVisible: false,
            headerLeft: () => null,
            headerRight: () => {
              const navigation = useNavigation<any>();
              return (
                <TouchableOpacity activeOpacity={0.7}
          onPress={() => navigation.goBack()}>
                  <Text style={{ color: Colors.primary, fontSize: 16, fontWeight: '500' }}>Done</Text>
                </TouchableOpacity>
              );
            },
          }}
        />
        <RootStack.Screen
          name="Search"
          component={SearchScreen}
          options={{
            presentation: 'modal',
            headerTitle: 'Search Users',
            headerStyle: { backgroundColor: Colors.bg },
            contentStyle: { backgroundColor: Colors.bg },
            headerTintColor: Colors.text,
            headerTitleStyle: { fontWeight: '600', color: Colors.text },
            headerShadowVisible: false,
            headerLeft: () => null,
            headerRight: () => {
              const navigation = useNavigation<any>();
              return (
                <TouchableOpacity activeOpacity={0.7}
          onPress={() => navigation.goBack()}>
                  <Text style={{ color: Colors.primary, fontSize: 16, fontWeight: '500' }}>Done</Text>
                </TouchableOpacity>
              );
            },
          }}
        />
        <RootStack.Screen
          name="Conversations"
          component={ConversationsScreen}
          options={{
            presentation: 'modal',
            headerTitle: 'Messages',
            headerStyle: { backgroundColor: Colors.bg },
            contentStyle: { backgroundColor: Colors.bg },
            headerTintColor: Colors.text,
            headerTitleStyle: { fontWeight: '600', color: Colors.text },
            headerShadowVisible: false,
            headerLeft: () => null,
            headerRight: () => {
              const navigation = useNavigation<any>();
              return (
                <TouchableOpacity activeOpacity={0.7}
          onPress={() => navigation.goBack()}>
                  <Text style={{ color: Colors.primary, fontSize: 16, fontWeight: '500' }}>Done</Text>
                </TouchableOpacity>
              );
            },
          }}
        />
        <RootStack.Screen
          name="Chat"
          component={ChatScreen}
          options={{
            headerStyle: { backgroundColor: Colors.bg },
            contentStyle: { backgroundColor: Colors.bg },
            headerTintColor: Colors.text,
            headerTitleStyle: { fontWeight: '600', color: Colors.text },
            headerShadowVisible: false,
          }}
        />
        <RootStack.Screen
          name="ComposeMessage"
          component={ComposeMessageScreen}
          options={{
            presentation: 'modal',
            headerTitle: 'New Message',
            headerStyle: { backgroundColor: Colors.bg },
            contentStyle: { backgroundColor: Colors.bg },
            headerTintColor: Colors.text,
            headerTitleStyle: { fontWeight: '600', color: Colors.text },
            headerShadowVisible: false,
            headerLeft: () => null,
            headerRight: () => {
              const navigation = useNavigation<any>();
              return (
                <TouchableOpacity activeOpacity={0.7}
          onPress={() => navigation.goBack()}>
                  <Text style={{ color: Colors.primary, fontSize: 16, fontWeight: '500' }}>Done</Text>
                </TouchableOpacity>
              );
            },
          }}
        />
        <RootStack.Screen
          name="ComposeGroup"
          component={ComposeGroupScreen}
          options={{
            presentation: 'modal',
            headerTitle: 'New Group',
            headerStyle: { backgroundColor: Colors.bg },
            contentStyle: { backgroundColor: Colors.bg },
            headerTintColor: Colors.text,
            headerTitleStyle: { fontWeight: '600', color: Colors.text },
            headerShadowVisible: false,
            headerLeft: () => null,
            headerRight: () => {
              const navigation = useNavigation<any>();
              return (
                <TouchableOpacity activeOpacity={0.7}
          onPress={() => navigation.goBack()}>
                  <Text style={{ color: Colors.primary, fontSize: 16, fontWeight: '500' }}>Done</Text>
                </TouchableOpacity>
              );
            },
          }}
        />
        <RootStack.Screen
          name="ProPaywall"
          component={ProPaywallScreen}
          options={{
            presentation: 'fullScreenModal',
            headerShown: false,
            animation: 'slide_from_bottom',
          }}
        />
      </RootStack.Navigator>
    </NavigationContainer>
  );
}
