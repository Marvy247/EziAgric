import { registerRootComponent } from 'expo';
import App from './App';
import { installCrashHandlers } from './lib/crashHandlers';

installCrashHandlers();

registerRootComponent(App);
