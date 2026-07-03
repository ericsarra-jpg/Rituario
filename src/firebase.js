import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import { getAuth } from 'firebase/auth';

const firebaseConfig = {
  apiKey: "AIzaSyACbCy-O8MhXnR0EOJO3AxVki0nwyoFsLQ",
  authDomain: "ritual-cbee0.firebaseapp.com",
  projectId: "ritual-cbee0",
  storageBucket: "ritual-cbee0.firebasestorage.app",
  messagingSenderId: "341380063392",
  appId: "1:341380063392:web:7947a289f246a9ae47e9c5"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);