import { initializeApp } from 'firebase/app'
import { getDatabase, ref, push } from 'firebase/database'

const firebaseConfig = {
    apiKey: "AIzaSyAPqdro8kgOvWBtneM8w6yw8ALtK-EHNnM",
    authDomain: "roland-szpond-b6cf7.firebaseapp.com",
    databaseURL: "https://pushpin-test.firebaseio.com",
    projectId: "roland-szpond-b6cf7",
    storageBucket: "roland-szpond-b6cf7.firebasestorage.app",
    messagingSenderId: "626534470214",
    appId: "1:626534470214:web:4ecad29bbab94f7e4eb047",
}

const app = initializeApp(firebaseConfig)
const db = getDatabase(app)

export async function trackPublish(record: {
    appId: string
    channel: string
    event: string
    data: unknown
    timestamp: number
    delivered: number
}) {
    await push(ref(db, `publishes/${record.appId}`), record)
}
