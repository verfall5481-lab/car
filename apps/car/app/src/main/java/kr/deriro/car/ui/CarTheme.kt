package kr.deriro.car.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

internal val Amber = Color(0xFFF0B74F)
internal val Charcoal = Color(0xFF161A1F)
internal val PanelSurface = Color(0xFF20262D)
internal val ActionSurface = Color(0xFF3A434E)
internal val DividerColor = Color(0xFF414A54)
internal val DisabledBorder = Color(0xFF59636E)
internal val DisabledInk = Color(0xFF8E98A3)
internal val Muted = Color(0xFFC3CAD2)
internal val Ink = Color(0xFFF5F6F8)
internal val Confirmed = Color(0xFF8BDBAE)
internal val Error = Color(0xFFFF9D90)

/** V-00 sizing. These are floors: no layout, compact included, may go below them. */
internal object CarSpacing {
    val minTouch = 76.dp
    val primaryHeight = 96.dp
    val buttonGap = 24.dp
    val contentGap = 24.dp
}

internal object CarType {
    const val CARD_TITLE_SP = 36
    const val BODY_SP = 28
    const val INFO_SP = 24
}

@Composable
internal fun CarTheme(compact: Boolean, content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = darkColorScheme(
            primary = Amber, onPrimary = Charcoal, background = Charcoal, onBackground = Ink,
            surface = PanelSurface, onSurface = Ink, onSurfaceVariant = Muted, error = Error,
        ),
        typography = Typography(
            headlineLarge = TextStyle(fontWeight = FontWeight.Bold, fontSize = if (compact) CarType.CARD_TITLE_SP.sp else 42.sp,
                lineHeight = if (compact) 44.sp else 52.sp),
            titleLarge = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = if (compact) 30.sp else 32.sp,
                lineHeight = if (compact) 38.sp else 40.sp),
            bodyLarge = TextStyle(fontSize = if (compact) CarType.BODY_SP.sp else 30.sp, lineHeight = if (compact) 36.sp else 38.sp),
            bodyMedium = TextStyle(fontSize = if (compact) CarType.INFO_SP.sp else 26.sp, lineHeight = if (compact) 32.sp else 34.sp),
            labelLarge = TextStyle(fontWeight = FontWeight.Bold, fontSize = if (compact) 26.sp else 28.sp,
                lineHeight = if (compact) 32.sp else 34.sp),
        ),
        content = content,
    )
}
