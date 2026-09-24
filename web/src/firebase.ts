import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';

const firebaseConfig = {
  projectId: 'lazyvault-node',
  appId: '1:689295982006:web:7b6b7a951b91c79b16d517',
  storageBucket: 'lazyvault-node.firebasestorage.app',
  apiKey: 'AIzaSyDmmj82oWommWVzUMgabRrAvOTbL790hhE',
  authDomain: 'lazyvault-node.firebaseapp.com',
  messagingSenderId: '689295982006',
};

export const firebaseApp = initializeApp(firebaseConfig);
export const db = getFirestore(firebaseApp);
