package kr.deriro.car.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
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
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

@Composable
internal fun VehicleContent(compact: Boolean, content: @Composable ColumnScope.() -> Unit) {
    Column(
        Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(if (compact) 10.dp else 20.dp),
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
    val spacing = Arrangement.spacedBy(8.dp)
    if (wide) {
        Row(
            modifier = Modifier.fillMaxWidth().height(IntrinsicSize.Min),
            horizontalArrangement = Arrangement.spacedBy(if (divider) 24.dp else 32.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(2f), verticalArrangement = spacing, content = first)
            if (divider) VerticalDivider(color = DividerColor)
            Column(Modifier.weight(1f), verticalArrangement = spacing, content = second)
        }
    } else {
        Column(verticalArrangement = spacing) {
            first()
            second()
        }
    }
}

@Composable
internal fun BoardingComplete(detail: String) {
    Column(
        Modifier.fillMaxWidth(),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Canvas(Modifier.size(56.dp)) {
            drawCircle(Color(0xFF24684F))
            val joint = Offset(size.width * .43f, size.height * .62f)
            drawLine(Ink, Offset(size.width * .27f, size.height * .47f), joint, 3.dp.toPx(), StrokeCap.Round)
            drawLine(Ink, joint, Offset(size.width * .73f, size.height * .33f), 3.dp.toPx(), StrokeCap.Round)
        }
        Heading(CarCopy.boarded)
        Info(detail, maxLines = 1)
    }
}

@Composable
internal fun CarButton(
    label: String,
    modifier: Modifier = Modifier,
    primary: Boolean = true,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    val large = MaterialTheme.typography.headlineLarge.fontSize.value >= 36
    Button(
        onClick = onClick, modifier = modifier.widthIn(min = 76.dp).heightIn(min = if (large && primary) 96.dp else 76.dp),
        enabled = enabled, shape = RoundedCornerShape(12.dp), contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
        colors = ButtonDefaults.buttonColors(
            containerColor = if (primary) Amber else ActionSurface,
            contentColor = if (primary) Charcoal else Ink,
            disabledContainerColor = DividerColor, disabledContentColor = Muted,
        ),
    ) {
        Text(label, style = MaterialTheme.typography.labelLarge, textAlign = TextAlign.Center)
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
