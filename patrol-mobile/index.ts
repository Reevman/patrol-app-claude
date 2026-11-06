import { registerRootComponent } from 'expo';

import { Platform } from 'react-native';

import App from './App';
import ManagerDashboard from './ManagerDashboard';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
const showManager = Platform.OS === 'web'
  && new URLSearchParams(window.location.search).has('manager');

registerRootComponent(showManager ? ManagerDashboard : App);
