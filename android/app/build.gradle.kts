plugins {
    alias(libs.plugins.android.application)
    id("com.google.gms.google-services")
}

android {
    namespace = "com.akshay.lazyvault"
    compileSdk {
        version = release(37)
    }

    defaultConfig {
        applicationId = "com.akshay.lazyvault"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildTypes {
        release {
            optimization {
                enable = false
            }
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures {
        viewBinding = true
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.appcompat)
    implementation(libs.material)
    implementation(libs.androidx.activity.ktx)
    implementation(libs.androidx.constraintlayout)
    implementation(libs.androidx.navigation.fragment.ktx)
    implementation(libs.androidx.navigation.ui.ktx)

    // DocumentFile for SAF folder picking
    implementation("androidx.documentfile:documentfile:1.0.1")

    // WorkManager (Periodic background indexing)
    implementation("androidx.work:work-runtime-ktx:2.9.0")

    // Firebase Cloud Messaging (FCM Data Messages)
    implementation("com.google.firebase:firebase-messaging:24.0.0")

    // OkHttp & Coroutines
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")

    // QR Code Generator (ZXing core - offline QR bitmap)
    implementation("com.google.zxing:core:3.5.3")

    // Google WebRTC Android SDK (Maven Central)
    implementation("io.dyte:webrtc:0.120.2")

    testImplementation(libs.junit)
    androidTestImplementation(libs.androidx.espresso.core)
    androidTestImplementation(libs.androidx.junit)
}