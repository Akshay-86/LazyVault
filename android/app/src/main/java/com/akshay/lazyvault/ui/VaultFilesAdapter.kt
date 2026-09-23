package com.akshay.lazyvault.ui

import android.view.LayoutInflater
import android.view.ViewGroup
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView
import com.akshay.lazyvault.data.CatalogItem
import com.akshay.lazyvault.databinding.ItemVaultFileBinding
import java.util.Locale

class VaultFilesAdapter(
    private val onItemClick: (CatalogItem) -> Unit
) : ListAdapter<CatalogItem, VaultFilesAdapter.FileViewHolder>(DiffCallback) {

    class FileViewHolder(val binding: ItemVaultFileBinding) : RecyclerView.ViewHolder(binding.root)

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): FileViewHolder {
        val binding = ItemVaultFileBinding.inflate(
            LayoutInflater.from(parent.context),
            parent,
            false
        )
        return FileViewHolder(binding)
    }

    override fun onBindViewHolder(holder: FileViewHolder, position: Int) {
        val item = getItem(position)
        val filename = if (item.name.isNotEmpty()) item.name else item.path.substringAfterLast('/')
        val formattedSize = formatFileSize(item.size)
        val shortSha = if (item.sha256.length > 12) {
            item.sha256.take(8) + "..." + item.sha256.takeLast(4)
        } else {
            item.sha256
        }

        holder.binding.textFileName.text = filename
        holder.binding.textFileMeta.text = "$formattedSize  •  SHA: $shortSha"

        holder.binding.cardFileRoot.setOnClickListener {
            onItemClick(item)
        }
        holder.binding.btnFileMenu.setOnClickListener {
            onItemClick(item)
        }
    }

    private fun formatFileSize(bytes: Long): String {
        if (bytes < 1024) return "$bytes B"
        val kb = bytes / 1024.0
        if (kb < 1024) return String.format(Locale.US, "%.1f KB", kb)
        val mb = kb / 1024.0
        if (mb < 1024) return String.format(Locale.US, "%.1f MB", mb)
        val gb = mb / 1024.0
        return String.format(Locale.US, "%.2f GB", gb)
    }

    companion object {
        private val DiffCallback = object : DiffUtil.ItemCallback<CatalogItem>() {
            override fun areItemsTheSame(oldItem: CatalogItem, newItem: CatalogItem): Boolean {
                return oldItem.sha256 == newItem.sha256 && oldItem.path == newItem.path
            }

            override fun areContentsTheSame(oldItem: CatalogItem, newItem: CatalogItem): Boolean {
                return oldItem == newItem
            }
        }
    }
}
