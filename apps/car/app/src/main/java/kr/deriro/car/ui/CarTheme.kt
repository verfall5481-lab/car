package kr.deriro.car.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

internal val Amber = Color(0xFFF0B74F)
internal val Charcoal = Color(0xFF161A1F)
internal val PanelSurface = Color(0xFF20262D)
internal val ActionSurface = Color(0xFF303740)
internal val DividerColor = Color(0xFF414A54)
internal val Muted = Color(0xFFC3CAD2)
internal val Ink = Color(0xFFF5F6F8)
internal val Confirmed = Color(0xFF8BDBAE)
internal val Error = Color(0xFFFF9D90)

@Composable
internal fun CarTheme(compact: Boolean, content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = darkColorScheme(
            primary = Amber, onPrimary = Charcoal, background = Charcoal, onBackground = Ink,
            surface = PanelSurface, onSurface = Ink, onSurfaceVariant = Muted, error = Error,
        ),
        typography = Typography(
            headlineLarge = TextStyle(fontWeight = FontWeight.Bold, fontSize = if (compact) 30.sp else 42.sp,
                lineHeight = if (compact) 38.sp else 53.sp),
            titleLarge = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = if (compact) 22.sp else 30.sp,
                lineHeight = if (compact) 28.sp else 36.sp),
            bodyLarge = TextStyle(fontSize = if (compact) 20.sp else 27.sp, lineHeight = if (compact) 27.sp else 36.sp),
            bodyMedium = TextStyle(fontSize = if (compact) 16.sp else 22.sp, lineHeight = if (compact) 22.sp else 30.sp),
            labelLarge = TextStyle(fontWeight = FontWeight.Bold, fontSize = if (compact) 18.sp else 25.sp,
                lineHeight = if (compact) 22.sp else 30.sp),
        ),
        content = content,
    )
}
