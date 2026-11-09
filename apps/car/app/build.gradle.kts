import java.util.Base64

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

fun buildSetting(name: String): String = providers.gradleProperty(name)
    .orElse(providers.environmentVariable(name)).getOrElse("").trim()

fun buildStringLiteral(value: String): String = "\"" + value
    .replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n").replace("\r", "\\r") + "\""

val publicKey = buildSetting("DERIRO_SUPABASE_PUBLISHABLE_KEY")
if (publicKey.isNotEmpty()) {
    val legacyRole = runCatching {
        String(Base64.getUrlDecoder().decode(publicKey.split('.')[1]), Charsets.UTF_8)
    }.getOrNull()
    require(publicKey.startsWith("sb_publishable_") || legacyRole?.contains(Regex("\"role\"\\s*:\\s*\"anon\"")) == true) {
        "DERIRO_SUPABASE_PUBLISHABLE_KEY requires a publishable or legacy anon key."
    }
}

android {
    namespace = "kr.deriro.car"
    compileSdk = 35
    useLibrary("android.car", false)

    defaultConfig {
        applicationId = "kr.deriro.car"
        minSdk = 28
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
    }

    flavorDimensions += "integration"
    productFlavors {
        create("demo") {
            dimension = "integration"
            applicationIdSuffix = ".demo"
        }
        create("pleos") {
            dimension = "integration"
            buildConfigField("String", "SUPABASE_URL", buildStringLiteral(buildSetting("DERIRO_SUPABASE_URL")))
            buildConfigField("String", "SUPABASE_KEY", buildStringLiteral(publicKey))
            buildConfigField("String", "WEB_URL", buildStringLiteral(buildSetting("DERIRO_WEB_URL")))
        }
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    sourceSets.maybeCreate("testPleos").resources.srcDir(rootProject.file("../../supabase/tests/fixtures"))

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin { jvmToolchain(17) }

dependencyLocking { lockAllConfigurations() }

dependencies {
    implementation("androidx.activity:activity-compose:1.10.1")
    implementation("androidx.compose.foundation:foundation:1.7.8")
    implementation("androidx.compose.material3:material3:1.3.2")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-viewmodel-ktx:2.8.7")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")

    implementation("com.google.zxing:core:3.5.3")
    "pleosImplementation"("ai.pleos.playground:Vehicle:2.3.2")
    "pleosImplementation"("ai.pleos.playground:NaviHelper:3.0.5")
    testImplementation("junit:junit:4.13.2")
    "testPleosImplementation"("org.json:json:20250107")
    "testPleosImplementation"("com.squareup.okhttp3:mockwebserver:4.12.0")
}
