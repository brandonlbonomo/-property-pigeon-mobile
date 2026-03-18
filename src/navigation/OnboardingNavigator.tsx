import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { NavigationContainer } from '@react-navigation/native';
import { navigationRef } from './navigationRef';
import { ProPaywallScreen } from '../components/ProPaywallModal';

import { LandingScreen } from '../screens/onboarding/LandingScreen';
import { CreateAccountScreen } from '../screens/onboarding/CreateAccountScreen';
import { PortfolioTypeScreen } from '../screens/onboarding/PortfolioTypeScreen';
import { AddPropertiesScreen } from '../screens/onboarding/AddPropertiesScreen';
import { DataSourcesScreen } from '../screens/onboarding/DataSourcesScreen';
import { PortfolioSetupScreen } from '../screens/onboarding/PortfolioSetupScreen';
import { DoneScreen } from '../screens/onboarding/DoneScreen';
import { SignInScreen } from '../screens/onboarding/SignInScreen';
import { ForgotPasswordScreen } from '../screens/onboarding/ForgotPasswordScreen';
import { CleanerCreateAccountScreen } from '../screens/onboarding/CleanerCreateAccountScreen';
import { CleanerFollowOwnerScreen } from '../screens/onboarding/CleanerFollowOwnerScreen';
import { CleanerDoneScreen } from '../screens/onboarding/CleanerDoneScreen';
import { CleanerBillingScreen } from '../screens/onboarding/CleanerBillingScreen';
import { CleanerPlaidLandingScreen } from '../screens/onboarding/CleanerPlaidLandingScreen';
import { CleanerPlaidScreen } from '../screens/onboarding/CleanerPlaidScreen';
import { BillingScreen } from '../screens/onboarding/BillingScreen';

const Stack = createNativeStackNavigator();

export function OnboardingNavigator() {
  return (
    <NavigationContainer ref={navigationRef}>
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        <Stack.Screen name="Landing" component={LandingScreen} />
        <Stack.Screen name="CreateAccount" component={CreateAccountScreen} />
        <Stack.Screen name="PortfolioType" component={PortfolioTypeScreen} />
        <Stack.Screen name="AddProperties" component={AddPropertiesScreen} />
        <Stack.Screen name="DataSources" component={DataSourcesScreen} />
        <Stack.Screen name="Billing" component={BillingScreen} />
        <Stack.Screen name="PortfolioSetup" component={PortfolioSetupScreen} />
        <Stack.Screen name="Done" component={DoneScreen} />
        <Stack.Screen name="SignIn" component={SignInScreen} />
        <Stack.Screen name="ForgotPassword" component={ForgotPasswordScreen} />
        <Stack.Screen name="CleanerCreateAccount" component={CleanerCreateAccountScreen} />
        <Stack.Screen name="CleanerFollowOwner" component={CleanerFollowOwnerScreen} />
        <Stack.Screen name="CleanerPlaidLanding" component={CleanerPlaidLandingScreen} />
        <Stack.Screen name="CleanerBilling" component={CleanerBillingScreen} />
        <Stack.Screen name="CleanerPlaid" component={CleanerPlaidScreen} />
        <Stack.Screen name="CleanerDone" component={CleanerDoneScreen} />
        <Stack.Screen
          name="ProPaywall"
          component={ProPaywallScreen}
          options={{
            presentation: 'fullScreenModal',
            headerShown: false,
            animation: 'slide_from_bottom',
          }}
        />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
