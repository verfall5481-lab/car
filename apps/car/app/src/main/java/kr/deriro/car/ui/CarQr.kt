package kr.deriro.car.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter

@Composable
internal fun CarQr(payload: String, description: String) {
    val matrix = remember(payload) { QRCodeWriter().encode(payload, BarcodeFormat.QR_CODE, 0, 0) }
    Canvas(Modifier.size(144.dp).clip(RoundedCornerShape(8.dp)).background(Color.White)
        .semantics { contentDescription = description }) {
        val unit = size.minDimension / matrix.width
        for (y in 0 until matrix.height) {
            for (x in 0 until matrix.width) {
                if (matrix[x, y]) drawRect(Charcoal, Offset(x * unit, y * unit), Size(unit, unit))
            }
        }
    }
}
