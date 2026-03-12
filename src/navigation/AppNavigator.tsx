import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

import { Colors, FontSize } from '../constants/theme';
import { HomeScreen } from '../screens/home/HomeScreen';
import { MoneyScreen } from '../screens/money/MoneyScreen';
import { MonthDetailScreen } from '../screens/money/MonthDetailScreen';
import { CalendarScreen } from '../screens/calendar/CalendarScreen';
import { InventoryScreen } from '../screens/inventory/InventoryScreen';
import { CleaningsScreen } from '../screens/cleanings/CleaningsScreen';
import { SettingsScreen } from '../screens/settings/SettingsScreen';
import { fmtMonthYear } from '../utils/format';

const Tab = createBottomTabNavigator();
const MoneyStack = createNativeStackNavigator();

function TabIcon({ emoji, focused }: { emoji: string; focused: boolean }) {
  return (
    <Text style={{ fontSize: focused ? 22 : 20, opacity: focused ? 1 : 0.55 }}>
      {emoji}
    </Text>
  );
}

function MoneyStackNavigator() {
  return (
    <MoneyStack.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: Colors.bg },
        headerTintColor: Colors.text,
        headerTitleStyle: { color: Colors.text },
      }}
    >
      <MoneyStack.Screen name="MoneyMain" component={MoneyScreen} options={{ title: 'Money' }} />
      <MoneyStack.Screen
        name="MonthDetail"
        component={MonthDetailScreen}
        options={({ route }: any) => ({
          title: fmtMonthYear((route.params?.month || '') + '-01'),
        })}
      />
    </MoneyStack.Navigator>
  );
}

const screenOpts = {
  headerStyle: { backgroundColor: Colors.bg },
  headerTintColor: Colors.text,
  headerTitleStyle: { color: Colors.text, fontWeight: '700' as const },
  headerShadowVisible: false,
};

export function AppNavigator() {
  return (
    <NavigationContainer>
      <Tab.Navigator
        screenOptions={{
          tabBarStyle: {
            backgroundColor: Colors.tabBar,
            borderTopColor: Colors.border,
            borderTopWidth: 1,
          },
          tabBarActiveTintColor: Colors.primary,
          tabBarInactiveTintColor: Colors.textDim,
          tabBarLabelStyle: { fontSize: FontSize.xs, marginBottom: 2 },
          ...screenOpts,
        }}
      >
        <Tab.Screen
          name="Home"
          component={HomeScreen}
          options={{
            title: 'Home',
            tabBarIcon: ({ focused }) => <TabIcon emoji="🏠" focused={focused} />,
          }}
        />
        <Tab.Screen
          name="Money"
          component={MoneyStackNavigator}
          options={{
            title: 'Money',
            headerShown: false,
            tabBarIcon: ({ focused }) => <TabIcon emoji="💰" focused={focused} />,
          }}
        />
        <Tab.Screen
          name="Calendar"
          component={CalendarScreen}
          options={{
            title: 'Occupancy',
            tabBarIcon: ({ focused }) => <TabIcon emoji="📅" focused={focused} />,
          }}
        />
        <Tab.Screen
          name="Inventory"
          component={InventoryScreen}
          options={{
            title: 'Inventory',
            tabBarIcon: ({ focused }) => <TabIcon emoji="📦" focused={focused} />,
          }}
        />
        <Tab.Screen
          name="Cleanings"
          component={CleaningsScreen}
          options={{
            title: 'Cleanings',
            tabBarIcon: ({ focused }) => <TabIcon emoji="🧹" focused={focused} />,
          }}
        />
        <Tab.Screen
          name="Settings"
          component={SettingsScreen}
          options={{
            title: 'Settings',
            tabBarIcon: ({ focused }) => <TabIcon emoji="⚙️" focused={focused} />,
          }}
        />
      </Tab.Navigator>
    </NavigationContainer>
  );
}
