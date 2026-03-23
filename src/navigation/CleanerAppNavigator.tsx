import React from 'react';
import { Text, TouchableOpacity } from 'react-native';
import { NavigationContainer, useNavigation } from '@react-navigation/native';
import { navigationRef } from './navigationRef';
import { ProPaywallScreen } from '../components/ProPaywallModal';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

import { Colors } from '../constants/theme';
import { SettingsScreen } from '../screens/settings/SettingsScreen';
import { NotificationsScreen } from '../screens/notifications/NotificationsScreen';
import { SearchScreen } from '../screens/search/SearchScreen';
import { ConversationsScreen } from '../screens/messages/ConversationsScreen';
import { ChatScreen } from '../screens/messages/ChatScreen';
import { ComposeMessageScreen } from '../screens/messages/ComposeMessageScreen';
import { ComposeGroupScreen } from '../screens/messages/ComposeGroupScreen';
import { CleanerPillNavigator } from './CleanerNavigator';
import { InvoiceWizardScreen } from '../screens/cleaner/InvoiceWizardScreen';
import { ViewUserProfileScreen } from '../screens/profile/ViewUserProfileScreen';

const RootStack = createNativeStackNavigator();

function DoneButton() {
  const navigation = useNavigation<any>();
  return (
    <TouchableOpacity activeOpacity={0.7}
          onPress={() => navigation.goBack()}>
      <Text style={{ color: Colors.primary, fontSize: 16, fontWeight: '500' }}>Done</Text>
    </TouchableOpacity>
  );
}

const modalOpts = {
  presentation: 'modal' as const,
  headerStyle: { backgroundColor: Colors.bg },
  headerTintColor: Colors.text,
  headerTitleStyle: { fontWeight: '600' as const, color: Colors.text },
  headerShadowVisible: false,
  headerLeft: () => null,
  headerRight: () => <DoneButton />,
};

export function CleanerAppNavigator() {
  return (
    <NavigationContainer ref={navigationRef}>
      <RootStack.Navigator>
        <RootStack.Screen
          name="Main"
          component={CleanerPillNavigator}
          options={{ headerShown: false }}
        />
        <RootStack.Screen
          name="Settings"
          component={SettingsScreen}
          options={{ ...modalOpts, headerTitle: 'Settings' }}
        />
        <RootStack.Screen
          name="Notifications"
          component={NotificationsScreen}
          options={{ ...modalOpts, headerTitle: 'Notifications' }}
        />
        <RootStack.Screen
          name="Search"
          component={SearchScreen}
          options={{ ...modalOpts, headerTitle: 'Search Users' }}
        />
        <RootStack.Screen
          name="Conversations"
          component={ConversationsScreen}
          options={{ ...modalOpts, headerTitle: 'Messages' }}
        />
        <RootStack.Screen
          name="Chat"
          component={ChatScreen}
          options={{
            headerStyle: { backgroundColor: Colors.bg },
            headerTintColor: Colors.text,
            headerTitleStyle: { fontWeight: '600' as const, color: Colors.text },
            headerShadowVisible: false,
          }}
        />
        <RootStack.Screen
          name="ComposeMessage"
          component={ComposeMessageScreen}
          options={{ ...modalOpts, headerTitle: 'New Message' }}
        />
        <RootStack.Screen
          name="ComposeGroup"
          component={ComposeGroupScreen}
          options={{ ...modalOpts, headerTitle: 'New Group' }}
        />
        <RootStack.Screen
          name="InvoiceWizard"
          component={InvoiceWizardScreen}
          options={{
            presentation: 'modal' as const,
            headerShown: false,
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
        <RootStack.Screen
          name="ViewUserProfile"
          component={ViewUserProfileScreen}
          options={{
            presentation: 'modal',
            headerTitle: 'Profile',
            headerStyle: { backgroundColor: Colors.bg },
            contentStyle: { backgroundColor: Colors.bg },
            headerTintColor: Colors.text,
            headerTitleStyle: { fontWeight: '600', color: Colors.text },
            headerShadowVisible: false,
            headerLeft: () => null,
            headerRight: () => {
              const navigation = useNavigation<any>();
              return (
                <TouchableOpacity activeOpacity={0.7} onPress={() => navigation.goBack()}>
                  <Text style={{ color: Colors.primary, fontSize: 16, fontWeight: '500' }}>Done</Text>
                </TouchableOpacity>
              );
            },
          }}
        />
      </RootStack.Navigator>
    </NavigationContainer>
  );
}
