package kr.deriro.car.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

/** Vertical stack for vehicle screens. The gap also keeps stacked buttons at least [CarSpacing.buttonGap] apart. */
@Composable
internal fun VehicleContent(content: @Composable ColumnScope.() -> Unit) {
    Column(
        Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(CarSpacing.contentGap),
        content = content,
    )
}

/** Horizontal button group with the V-00 minimum gap between buttons. */
@Composable
internal fun ButtonRow(content: @Composable RowScope.() -> Unit) {
    Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(CarSpacing.buttonGap),
        verticalAlignment = Alignment.CenterVertically,
        content = content,
    )
}

@Composable
internal fun Split(
    wide: Boolean,
    divider: Boolean = true,
    first: @Composable ColumnScope.() -> Unit,
    second: @Composable ColumnScope.() -> Unit,
) {
    val spacing = Arrangement.spacedBy(12.dp)
    if (wide) {
        Row(
            modifier = Modifier.fillMaxWidth().height(IntrinsicSize.Min),
            horizontalArrangement = Arrangement.spacedBy(32.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(2f), verticalArrangement = spacing, content = first)
            if (divider) VerticalDivider(color = DividerColor)
            Column(Modifier.weight(1f), verticalArrangement = spacing, content = second)
        }
    } else {
        Column(verticalArrangement = Arrangement.spacedBy(CarSpacing.contentGap)) {
            Column(verticalArrangement = spacing, content = first)
            Column(verticalArrangement = spacing, content = second)
        }
    }
}

@Composable
internal fun BoardingComplete(detail: String) {
    Column(
        Modifier.fillMaxWidth(),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Canvas(Modifier.size(64.dp)) {
            drawCircle(Color(0xFF24684F))
            val joint = Offset(size.width * .43f, size.height * .62f)
            drawLine(Ink, Offset(size.width * .27f, size.height * .47f), joint, 4.dp.toPx(), StrokeCap.Round)
            drawLine(Ink, joint, Offset(size.width * .73f, size.height * .33f), 4.dp.toPx(), StrokeCap.Round)
        }
        Heading(CarCopy.boarded)
        Info(detail, maxLines = 1)
    }
}

/**
 * Enabled buttons are filled (amber for the primary action, slate for the rest).
 * Disabled buttons drop the fill and keep only an outline with dimmed text, so they never look like an enabled secondary.
 */
@Composable
internal fun CarButton(
    label: String,
    modifier: Modifier = Modifier,
    primary: Boolean = true,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    Button(
        onClick = onClick,
        modifier = modifier.widthIn(min = CarSpacing.minTouch)
            .heightIn(min = if (primary) CarSpacing.primaryHeight else CarSpacing.minTouch),
        enabled = enabled,
        shape = RoundedCornerShape(12.dp),
        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
        colors = ButtonDefaults.buttonColors(
            containerColor = if (primary) Amber else ActionSurface,
            contentColor = if (primary) Charcoal else Ink,
            disabledContainerColor = Color.Transparent,
            disabledContentColor = DisabledInk,
        ),
        border = if (enabled) null else BorderStroke(2.dp, DisabledBorder),
    ) {
        Text(label, style = MaterialTheme.typography.labelLarge, textAlign = TextAlign.Center)
    }
}

/** Short status line that must be readable at a glance, including while driving. */
@Composable
internal fun NoticeBar(label: String, color: Color, maxLines: Int) {
    Row(
        Modifier.fillMaxWidth().height(IntrinsicSize.Min).clip(RoundedCornerShape(12.dp)).background(PanelSurface)
            .semantics { liveRegion = LiveRegionMode.Polite },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.width(8.dp).fillMaxHeight().background(color))
        Text(
            label, Modifier.padding(horizontal = 20.dp, vertical = 14.dp), style = MaterialTheme.typography.titleLarge,
            color = color, maxLines = maxLines, overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
internal fun Heading(label: String, color: Color = Ink, maxLines: Int = Int.MAX_VALUE) {
    Text(label, style = MaterialTheme.typography.headlineLarge, color = color, maxLines = maxLines, overflow = TextOverflow.Ellipsis)
}

@Composable
internal fun Title(label: String, color: Color = Ink) {
    Text(label, style = MaterialTheme.typography.titleLarge, color = color)
}

@Composable
internal fun Body(label: String, maxLines: Int = Int.MAX_VALUE) {
    Text(label, style = MaterialTheme.typography.bodyLarge, color = Ink, maxLines = maxLines, overflow = TextOverflow.Ellipsis)
}

@Composable
internal fun Info(label: String, color: Color = Muted, maxLines: Int = Int.MAX_VALUE) {
    Text(label, style = MaterialTheme.typography.bodyMedium, color = color, maxLines = maxLines, overflow = TextOverflow.Ellipsis)
}

@Composable
internal fun Rule() { HorizontalDivider(color = DividerColor) }
