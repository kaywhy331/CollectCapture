import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
}

val commandPublicKey = providers.gradleProperty("LOCALCLEAR_COMMAND_PUBLIC_KEY_BASE64")
    .orElse("")
val commandKeyId = providers.gradleProperty("LOCALCLEAR_COMMAND_KEY_ID")
    .orElse("default")
val temporaryMediaRetentionMinutes = providers
    .gradleProperty("LOCALCLEAR_TEMP_MEDIA_RETENTION_MINUTES")
    .orElse("15")

android {
    namespace = "com.localclear.sellerhub"
    compileSdk = 37

    defaultConfig {
        applicationId = "com.localclear.sellerhub"
        minSdk = 30
        targetSdk = 36
        versionCode = 1
        versionName = "1.0.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        buildConfigField("String", "COMMAND_PUBLIC_KEY_BASE64", "\"${commandPublicKey.get()}\"")
        buildConfigField("String", "COMMAND_KEY_ID", "\"${commandKeyId.get()}\"")
        buildConfigField(
            "int",
            "TEMP_MEDIA_RETENTION_MINUTES",
            temporaryMediaRetentionMinutes.get(),
        )
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlin {
        compilerOptions {
            jvmTarget = JvmTarget.JVM_17
            freeCompilerArgs.add("-Xannotation-default-target=param-property")
        }
    }

    packaging {
        resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2026.08.00")
    implementation(composeBom)
    androidTestImplementation(composeBom)

    implementation("androidx.activity:activity-compose:1.13.0")
    implementation("androidx.core:core-ktx:1.19.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.11.0")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.11.0")
    implementation("androidx.work:work-runtime-ktx:2.11.2")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("com.google.android.gms:play-services-code-scanner:16.1.0")

    debugImplementation("androidx.compose.ui:ui-tooling")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}
